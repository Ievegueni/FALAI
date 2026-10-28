import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { countSegments } from "@falai/providers";
import { normalizeAoPhone } from "@falai/shared";
import { getTenantSmsConfig } from "./sms.service.js";
import { dispatchQueuedMessage, recoverInterruptedSms } from "./sms.service.js";

/**
 * Campanhas de SMS em massa. Ao preparar, cria uma mensagem QUEUED por contacto
 * (com o texto já interpolado). Ao iniciar, despacha as mensagens com um throttle
 * simples e vai actualizando os contadores da campanha.
 */

/** Substitui {name}, {phone} e {atributos} no template pelo valor do contacto. */
export function interpolate(template: string, contact: { name: string | null; phone: string | null; attributes: unknown }): string {
  const attrs = (contact.attributes ?? {}) as Record<string, unknown>;
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key === "name") return contact.name ?? "";
    if (key === "phone") return contact.phone ?? "";
    const v = attrs[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Cria as mensagens QUEUED (destinatários) de uma campanha a partir de contactos. */
export async function prepareRecipients(
  tenantId: string,
  campaignId: string,
  contactIds: string[] | "all" // "all" = todos os contactos elegíveis do tenant
): Promise<{ added: number }> {
  const campaign = await prisma.smsCampaign.findFirst({
    where: { id: campaignId, tenantId },
    select: { body: true },
  });
  if (!campaign) throw new Error("Campanha não encontrada");

  const cfg = await getTenantSmsConfig(tenantId);
  const contacts = await prisma.contact.findMany({
    where: { tenantId, ...(contactIds !== "all" && { id: { in: contactIds } }), optedOutAt: null, phone: { not: null } },
    select: { id: true, name: true, phone: true, attributes: true },
  });

  const existing = await prisma.smsMessage.findMany({ where: { tenantId, campaignId }, select: { toNumber: true } });
  const fresh = dedupeByPhone(contacts, existing.map((m) => m.toNumber));

  await prisma.smsMessage.createMany({
    data: fresh.map((c) => {
      const text = interpolate(campaign.body, c);
      const segments = countSegments(text);
      return {
        tenantId,
        campaignId,
        contactId: c.id,
        toNumber: c.phone!, // filtrado na query
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
  return { added: fresh.length };
}

/** Chave de deduplicação: nacional de 9 dígitos quando é número angolano, senão só os dígitos. */
function phoneKey(raw: string): string {
  return normalizeAoPhone(raw) ?? raw.replace(/\D/g, "");
}

/**
 * Tira os contactos cujo telefone (normalizado) já está na campanha ou se
 * repete no próprio lote — voltar a adicionar contactos não duplica mensagens.
 */
export function dedupeByPhone<T extends { phone: string | null }>(contacts: T[], alreadyInCampaign: string[]): T[] {
  const seen = new Set(alreadyInCampaign.map(phoneKey));
  return contacts.filter((c) => {
    if (!c.phone) return false;
    const k = phoneKey(c.phone);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Inicia a campanha: marca RUNNING e despacha as mensagens QUEUED em segundo plano,
 * respeitando o throttlePerMinute. Actualiza contadores e marca DONE no fim.
 */
export async function startCampaign(fastify: FastifyInstance, tenantId: string, campaignId: string): Promise<void> {
  // Arranque atómico: dois cliques (ou dois pedidos) já não lançam dois ciclos
  // a despachar — e a cobrar — as mesmas mensagens em duplicado.
  const claimed = await prisma.smsCampaign.updateMany({
    where: { id: campaignId, tenantId, status: { not: "RUNNING" } },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count === 0) {
    const exists = await prisma.smsCampaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true } });
    if (!exists) throw new Error("Campanha não encontrada");
    return; // já a correr
  }
  runCampaign(fastify, tenantId, campaignId);
}

/**
 * Retoma as campanhas que ficaram RUNNING com mensagens QUEUED: o despacho vive
 * em memória e um reinício da API deixava-as presas (e o "Iniciar" não as
 * relançava, por já estarem RUNNING). Chamar uma vez no arranque.
 */
export async function resumeRunningSmsCampaigns(fastify: FastifyInstance): Promise<number> {
  // Primeiro as interrompidas a meio do envio (SENDING): saldo de volta, sem reenvio.
  const recovered = await recoverInterruptedSms();
  if (recovered > 0) fastify.log.warn({ recovered }, "sms.interrupted_recovered");
  const running = await prisma.smsCampaign.findMany({ where: { status: "RUNNING" }, select: { id: true, tenantId: true } });
  for (const c of running) runCampaign(fastify, c.tenantId, c.id);
  return running.length;
}

/** Despacha as mensagens QUEUED com throttle, em segundo plano. */
function runCampaign(fastify: FastifyInstance, tenantId: string, campaignId: string): void {
  void (async () => {
    try {
      const campaign = await prisma.smsCampaign.findUniqueOrThrow({ where: { id: campaignId }, select: { throttlePerMinute: true } });
      const delayMs = Math.max(0, Math.floor(60_000 / Math.max(1, campaign.throttlePerMinute)));
      const queued = await prisma.smsMessage.findMany({
        where: { tenantId, campaignId, status: "QUEUED" },
        select: { id: true },
      });
      for (const m of queued) {
        // Pausa/cancelamento: se o estado mudou, pára.
        const cur = await prisma.smsCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
        if (!cur || cur.status !== "RUNNING") break;

        const r = await dispatchQueuedMessage(fastify, tenantId, m.id);
        if (r.status === "SKIPPED") continue; // já reclamada por outro ciclo
        // increment e não set: retomar uma campanha (ou o arranque após um
        // reinício) apagava os contadores da corrida anterior.
        await prisma.smsCampaign.update({
          where: { id: campaignId },
          data:
            r.status === "SENT"
              ? { sentCount: { increment: 1 }, costCents: { increment: r.costCents } }
              : { failedCount: { increment: 1 } },
        });
        if (delayMs > 0) await sleep(delayMs);
      }
    } catch (err) {
      fastify.log.error({ err, campaignId, tenantId }, "sms_campaign.dispatch_failed");
    } finally {
      await prisma.smsCampaign
        .updateMany({ where: { id: campaignId, status: "RUNNING" }, data: { status: "DONE", completedAt: new Date() } })
        .catch((err) => fastify.log.error({ err, campaignId }, "sms_campaign.finish_failed"));
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
