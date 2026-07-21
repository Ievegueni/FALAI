import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { countSegments } from "@falai/providers";
import { getTenantSmsConfig } from "./sms.service.js";
import { dispatchQueuedMessage } from "./sms.service.js";

/**
 * Campanhas de SMS em massa. Ao preparar, cria uma mensagem QUEUED por contacto
 * (com o texto já interpolado). Ao iniciar, despacha as mensagens com um throttle
 * simples e vai actualizando os contadores da campanha.
 */

/** Substitui {name}, {phone} e {atributos} no template pelo valor do contacto. */
export function interpolate(template: string, contact: { name: string | null; phone: string; attributes: unknown }): string {
  const attrs = (contact.attributes ?? {}) as Record<string, unknown>;
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key === "name") return contact.name ?? "";
    if (key === "phone") return contact.phone;
    const v = attrs[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Cria as mensagens QUEUED (destinatários) de uma campanha a partir de contactos. */
export async function prepareRecipients(
  tenantId: string,
  campaignId: string,
  contactIds: string[]
): Promise<{ added: number }> {
  const campaign = await prisma.smsCampaign.findFirst({
    where: { id: campaignId, tenantId },
    select: { body: true },
  });
  if (!campaign) throw new Error("Campanha não encontrada");

  const cfg = await getTenantSmsConfig(tenantId);
  const contacts = await prisma.contact.findMany({
    where: { tenantId, id: { in: contactIds }, optedOutAt: null },
    select: { id: true, name: true, phone: true, attributes: true },
  });

  await prisma.smsMessage.createMany({
    data: contacts.map((c) => {
      const text = interpolate(campaign.body, c);
      const segments = countSegments(text);
      return {
        tenantId,
        campaignId,
        contactId: c.id,
        toNumber: c.phone,
        body: text,
        segments,
        costCents: segments * cfg.pricePerSegmentCents,
        status: "QUEUED" as const,
        senderId: cfg.senderId,
      };
    }),
  });

  const total = await prisma.smsMessage.count({ where: { tenantId, campaignId } });
  await prisma.smsCampaign.update({ where: { id: campaignId }, data: { totalRecipients: total } });
  return { added: contacts.length };
}

/**
 * Inicia a campanha: marca RUNNING e despacha as mensagens QUEUED em segundo plano,
 * respeitando o throttlePerMinute. Actualiza contadores e marca DONE no fim.
 */
export async function startCampaign(fastify: FastifyInstance, tenantId: string, campaignId: string): Promise<void> {
  const campaign = await prisma.smsCampaign.findFirst({
    where: { id: campaignId, tenantId },
    select: { status: true, throttlePerMinute: true },
  });
  if (!campaign) throw new Error("Campanha não encontrada");
  if (campaign.status === "RUNNING") return;

  await prisma.smsCampaign.update({
    where: { id: campaignId },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  const delayMs = Math.max(0, Math.floor(60_000 / Math.max(1, campaign.throttlePerMinute)));

  // Fire-and-forget: despacha sequencialmente com throttle.
  void (async () => {
    let sent = 0;
    let failed = 0;
    let cost = 0;
    try {
      const queued = await prisma.smsMessage.findMany({
        where: { tenantId, campaignId, status: "QUEUED" },
        select: { id: true },
      });
      for (const m of queued) {
        // Pausa/cancelamento: se o estado mudou, pára.
        const cur = await prisma.smsCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
        if (!cur || cur.status !== "RUNNING") break;

        const r = await dispatchQueuedMessage(fastify, tenantId, m.id);
        if (r.status === "SENT") {
          sent++;
          cost += r.costCents;
        } else {
          failed++;
        }
        await prisma.smsCampaign.update({
          where: { id: campaignId },
          data: { sentCount: sent, failedCount: failed, costCents: cost },
        });
        if (delayMs > 0) await sleep(delayMs);
      }
    } catch (err) {
      fastify.log.error({ err, campaignId, tenantId }, "sms_campaign.dispatch_failed");
    } finally {
      const cur = await prisma.smsCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
      if (cur?.status === "RUNNING") {
        await prisma.smsCampaign.update({
          where: { id: campaignId },
          data: { status: "DONE", completedAt: new Date() },
        });
      }
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
