import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { FuturixAdapter, countSegments, type SmsProvider } from "@falai/providers";
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

  // Regista a mensagem (QUEUED) antes de despachar
  const msg = await prisma.smsMessage.create({
    data: {
      tenantId,
      toNumber: input.to,
      body: input.body,
      segments,
      costCents,
      status: "QUEUED",
      senderId: cfg.senderId,
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
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

/**
 * Despacha uma mensagem de campanha já criada (status QUEUED): reserva o saldo,
 * envia e actualiza estado + carteira. Devolve o resultado para a campanha somar.
 */
export async function dispatchQueuedMessage(
  fastify: FastifyInstance,
  tenantId: string,
  msgId: string
): Promise<{ status: "SENT" | "FAILED"; costCents: number }> {
  const msg = await prisma.smsMessage.findFirst({
    where: { id: msgId, tenantId, status: "QUEUED" },
    select: { id: true, toNumber: true, body: true, segments: true, costCents: true, senderId: true },
  });
  if (!msg) return { status: "FAILED", costCents: 0 };

  const reserved = await reserveBalance(tenantId, msg.costCents);
  if (!reserved) {
    await prisma.smsMessage.update({ where: { id: msg.id }, data: { status: "FAILED", failReason: "Saldo insuficiente" } });
    return { status: "FAILED", costCents: 0 };
  }

  let ok = false;
  let providerMsgId: string | null = null;
  let failReason: string | null = null;
  try {
    const adapter = await getTenantSms(fastify, tenantId);
    const res = await adapter.send({
      to: msg.toNumber,
      body: msg.body,
      ...(msg.senderId ? { senderId: msg.senderId } : {}),
      reference: msg.id,
    });
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
