import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { FuturixAdapter, countSegments, type SmsProvider, type SendSmsResult } from "@falai/providers";
import { decryptSecret } from "./crypto.service.js";
import { reserveBalance } from "./billing.service.js";

/**
 * Envio de SMS via gateway Futurix. As credenciais (API key + Sender ID) e o
 * preço por segmento são configurados POR TENANT no backoffice. O base URL e o
 * modo stub do gateway são globais (providerConfig).
 *
 * Cobrança: preço/segmento × nº de segmentos, debitado da carteira. Se o envio
 * ao gateway falhar, o valor é devolvido e a mensagem fica FAILED.
 */

interface CacheEntry {
  fingerprint: string;
  adapter: FuturixAdapter;
}
const cache = new Map<string, CacheEntry>();

export function invalidateTenantSms(tenantId: string): void {
  cache.delete(tenantId);
}

export class SmsNotConfiguredError extends Error {
  constructor() {
    super("SMS não está configurado para este cliente");
    this.name = "SmsNotConfiguredError";
  }
}
export class SmsDisabledError extends Error {
  constructor() {
    super("O plano do cliente não inclui SMS");
    this.name = "SmsDisabledError";
  }
}
export class InsufficientBalanceError extends Error {
  constructor() {
    super("Saldo insuficiente");
    this.name = "InsufficientBalanceError";
  }
}

interface TenantSmsConfig {
  smsEnabled: boolean;
  apiKey: string | null;
  senderId: string | null;
  pricePerSegmentCents: number;
}

/** Lê a configuração de SMS efectiva do tenant (credenciais + preço + gate do plano). */
export async function getTenantSmsConfig(tenantId: string): Promise<TenantSmsConfig> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      smsApiKey: true,
      smsSenderId: true,
      smsPriceSegmentCents: true,
      plan: { select: { smsEnabled: true, pricePerSmsCents: true } },
    },
  });
  if (!tenant) throw new SmsNotConfiguredError();
  return {
    smsEnabled: tenant.plan.smsEnabled,
    apiKey: tenant.smsApiKey ? decryptSecret(tenant.smsApiKey) : null,
    senderId: tenant.smsSenderId,
    pricePerSegmentCents: tenant.smsPriceSegmentCents ?? tenant.plan.pricePerSmsCents,
  };
}

/** Resolve (e cacheia) o adaptador Futurix do tenant. */
export async function getTenantSms(fastify: FastifyInstance, tenantId: string): Promise<SmsProvider> {
  const cfg = await getTenantSmsConfig(tenantId);
  if (!cfg.smsEnabled) throw new SmsDisabledError();
  if (!cfg.apiKey) throw new SmsNotConfiguredError();

  const { baseUrl, stubMode } = fastify.providerConfig.futurix;
  const fingerprint = `${baseUrl}|${cfg.apiKey}|${cfg.senderId ?? ""}|${stubMode}`;
  const cached = cache.get(tenantId);
  if (cached && cached.fingerprint === fingerprint) return cached.adapter;

  const adapter = new FuturixAdapter({
    baseUrl,
    apiKey: cfg.apiKey,
    ...(cfg.senderId ? { defaultSenderId: cfg.senderId } : {}),
    stubMode,
  });
  cache.set(tenantId, { fingerprint, adapter });
  return adapter;
}

export interface SendSmsInput {
  to: string;
  body: string;
  contactId?: string | null;
  campaignId?: string | null;
  /** O que originou a mensagem; ausente = envio manual. Ver SmsMessage.trigger. */
  trigger?: string;
}

export interface SentSms {
  id: string;
  status: string;
  segments: number;
  costCents: number;
}

/**
 * Envia um SMS: valida config/plano, calcula segmentos e custo, reserva o saldo,
 * grava a mensagem e despacha para o gateway. Devolve a mensagem persistida.
 */
export async function sendSms(fastify: FastifyInstance, tenantId: string, input: SendSmsInput): Promise<SentSms> {
  const cfg = await getTenantSmsConfig(tenantId);
  if (!cfg.smsEnabled) throw new SmsDisabledError();
  if (!cfg.apiKey) throw new SmsNotConfiguredError();

  const segments = countSegments(input.body);
  const costCents = segments * cfg.pricePerSegmentCents;

  const reserved = await reserveBalance(tenantId, costCents);
  if (!reserved) throw new InsufficientBalanceError();

  // Só se liga a mensagem a um contacto deste cliente. As rotas já validam; isto
  // protege quem chame o serviço directamente com um id vindo de fora.
  const contactId = input.contactId
    ? (await prisma.contact.findFirst({ where: { id: input.contactId, tenantId }, select: { id: true } }))?.id
    : undefined;

  // Regista a mensagem antes de despachar. SENDING = saldo já reservado: se a
  // API cair a meio, recoverInterruptedSms devolve-o no arranque.
  const msg = await prisma.smsMessage.create({
    data: {
      tenantId,
      toNumber: input.to,
      body: input.body,
      segments,
      costCents,
      status: "SENDING",
      senderId: cfg.senderId,
      ...(contactId ? { contactId } : {}),
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
    },
    select: { id: true },
  });

  let status: "SENT" | "FAILED" = "FAILED";
  let providerMsgId: string | null = null;
  let failReason: string | null = null;
  try {
    const adapter = await getTenantSms(fastify, tenantId);
    const res = await adapter.send({
      to: input.to,
      body: input.body,
      ...(cfg.senderId ? { senderId: cfg.senderId } : {}),
      reference: msg.id,
    });
    if (res.accepted) {
      status = "SENT";
      providerMsgId = res.providerMsgId;
    } else {
      failReason = res.details ?? "Rejeitado pelo gateway";
    }
  } catch (err) {
    failReason = err instanceof Error ? err.message : String(err);
  }

  if (status === "SENT") {
    // Confirma a cobrança com um movimento de carteira
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { balanceCents: true },
    });
    await prisma.$transaction([
      prisma.smsMessage.update({
        where: { id: msg.id },
        data: { status, providerMsgId },
      }),
      prisma.walletTransaction.create({
        data: {
          tenantId,
          type: "SMS_CHARGE",
          amountCents: -costCents,
          balanceAfterCents: tenant.balanceCents,
          note: `SMS ${msg.id} — ${segments} seg.`,
          reference: msg.id,
        },
      }),
    ]);
    return { id: msg.id, status, segments, costCents };
  }

  // Falhou → devolve o saldo reservado e marca FAILED
  await prisma.$transaction([
    prisma.tenant.update({ where: { id: tenantId }, data: { balanceCents: { increment: costCents } } }),
    prisma.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", failReason } }),
  ]);
  fastify.log.warn({ tenantId, msgId: msg.id, failReason }, "sms.send_failed");
  return { id: msg.id, status: "FAILED", segments, costCents: 0 };
}

/** Esperas entre tentativas nas campanhas quando a Futurix falha de forma transitória. */
const CAMPAIGN_RETRY_DELAYS_MS = [1_000, 4_000];

/**
 * Envia com novas tentativas só para falhas transitórias (429, 5xx, timeout).
 * 401/402/422 e afins falham logo, com o motivo dado pelo adaptador.
 */
export async function sendWithRetry(
  send: () => Promise<SendSmsResult>,
  delaysMs: readonly number[] = CAMPAIGN_RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SendSmsResult> {
  let res = await send();
  for (const ms of delaysMs) {
    if (res.accepted || !res.retryable) break;
    await wait(ms);
    res = await send();
  }
  return res;
}

// Instante de arranque deste processo: o que estiver SENDING de antes disto
// ficou interrompido; o que for reclamado depois é envio legítimo em curso.
const BOOTED_AT = new Date();

/**
 * Arranque: mensagens SENDING de antes do arranque foram interrompidas entre
 * reservar o saldo e gravar o resultado. Não se reenviam (o gateway pode já as
 * ter aceitado — reenviar duplicava a mensagem ao destinatário): ficam FAILED
 * e o saldo reservado volta ao cliente, uma única vez (claim atómico).
 */
export async function recoverInterruptedSms(): Promise<number> {
  const stuck = await prisma.smsMessage.findMany({
    where: { status: "SENDING", updatedAt: { lt: BOOTED_AT } },
    select: { id: true, tenantId: true, costCents: true },
  });
  let recovered = 0;
  for (const m of stuck) {
    await prisma.$transaction(async (tx) => {
      const c = await tx.smsMessage.updateMany({
        where: { id: m.id, status: "SENDING" },
        data: { status: "FAILED", failReason: "Envio interrompido (reinício da API) — estado no gateway desconhecido; saldo devolvido" },
      });
      if (c.count === 0) return;
      if (m.costCents > 0) {
        await tx.tenant.update({ where: { id: m.tenantId }, data: { balanceCents: { increment: m.costCents } } });
      }
      recovered++;
    });
  }
  return recovered;
}

/**
 * Despacha uma mensagem de campanha já criada (status QUEUED): reserva o saldo,
 * envia e actualiza estado + carteira. Devolve o resultado para a campanha somar.
 */
export async function dispatchQueuedMessage(
  fastify: FastifyInstance,
  tenantId: string,
  msgId: string
): Promise<{ status: "SENT" | "FAILED" | "SKIPPED"; costCents: number }> {
  // Reclamar (QUEUED → SENDING) e reservar o saldo na mesma transacção:
  // SENDING implica saldo reservado, e uma mensagem só é reclamada uma vez —
  // retomar a campanha depois de um crash já não a cobra outra vez.
  const claim = await prisma.$transaction(async (tx) => {
    const c = await tx.smsMessage.updateMany({ where: { id: msgId, tenantId, status: "QUEUED" }, data: { status: "SENDING" } });
    if (c.count === 0) return null;
    const m = await tx.smsMessage.findUniqueOrThrow({
      where: { id: msgId },
      select: { id: true, toNumber: true, body: true, segments: true, costCents: true, senderId: true },
    });
    const reserved = m.costCents <= 0 || (await tx.$executeRaw`
      UPDATE "Tenant" SET "balanceCents" = "balanceCents" - ${m.costCents}
      WHERE id = ${tenantId} AND "balanceCents" + "creditLimitCents" >= ${m.costCents}
    `) > 0;
    if (!reserved) {
      await tx.smsMessage.update({ where: { id: m.id }, data: { status: "FAILED", failReason: "Saldo insuficiente" } });
      return { msg: m, reserved: false };
    }
    return { msg: m, reserved: true };
  });
  if (!claim) return { status: "SKIPPED", costCents: 0 };
  if (!claim.reserved) return { status: "FAILED", costCents: 0 };
  const { msg } = claim;

  let ok = false;
  let providerMsgId: string | null = null;
  let failReason: string | null = null;
  try {
    const adapter = await getTenantSms(fastify, tenantId);
    const res = await sendWithRetry(() =>
      adapter.send({
        to: msg.toNumber,
        body: msg.body,
        ...(msg.senderId ? { senderId: msg.senderId } : {}),
        reference: msg.id,
      }),
    );
    ok = res.accepted;
    providerMsgId = res.providerMsgId;
    if (!ok) failReason = res.details ?? "Rejeitado pelo gateway";
  } catch (err) {
    failReason = err instanceof Error ? err.message : String(err);
  }

  if (ok) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { balanceCents: true } });
    await prisma.$transaction([
      prisma.smsMessage.update({ where: { id: msg.id }, data: { status: "SENT", providerMsgId } }),
      prisma.walletTransaction.create({
        data: {
          tenantId,
          type: "SMS_CHARGE",
          amountCents: -msg.costCents,
          balanceAfterCents: tenant.balanceCents,
          note: `SMS ${msg.id} (campanha)`,
          reference: msg.id,
        },
      }),
    ]);
    return { status: "SENT", costCents: msg.costCents };
  }

  await prisma.$transaction([
    prisma.tenant.update({ where: { id: tenantId }, data: { balanceCents: { increment: msg.costCents } } }),
    prisma.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", failReason } }),
  ]);
  return { status: "FAILED", costCents: 0 };
}
