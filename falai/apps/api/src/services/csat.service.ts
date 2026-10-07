import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Inbox } from "@falai/db";
import { sendSms } from "./sms.service.js";
import { isSmsReachable } from "./missedCallSms.service.js";

/**
 * Satisfação do cliente (CSAT, centro de atendimento, fase 8) — ver
 * docs/PLANO-CENTRO-ATENDIMENTO.md. Escala de 1 a 5; "satisfeito" = 4 ou 5.
 *
 *   Voz   — quando o agente desliga, quem ligou ouve a pergunta e carrega numa
 *           tecla (inboundCallRouter.service.ts). O tempo do inquérito não se cobra.
 *   Texto — ao resolver a conversa pergunta-se pelo mesmo canal; a resposta
 *           "1"–"5" nas 24 h seguintes fica registada e não abre conversa nova.
 *   SMS   — no fim de uma chamada atendida segue um link (pago, como qualquer SMS).
 */

export const DEFAULT_QUESTION = "Numa escala de 1 a 5, em que 5 é muito satisfeito, como avalia o atendimento?";
export const DEFAULT_THANKS = "Obrigado pela sua avaliação.";
const TEXT_WINDOW_MS = 24 * 3600_000;
export const CSAT_SMS_TRIGGER = "CSAT";

export const csatConfigSchema = z.object({
  voice: z.boolean().default(false),
  text: z.boolean().default(false),
  sms: z.boolean().default(false),
  question: z.string().trim().min(5).max(300).default(DEFAULT_QUESTION),
  thanks: z.string().trim().min(2).max(200).default(DEFAULT_THANKS),
});
export type CsatConfig = z.infer<typeof csatConfigSchema>;

export function parseCsatConfig(raw: unknown): CsatConfig {
  const r = csatConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : csatConfigSchema.parse({});
}

export async function tenantCsatConfig(tenantId: string): Promise<CsatConfig> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { csatConfig: true } });
  return parseCsatConfig(t?.csatConfig);
}

/** Nomes dos áudios do inquérito por voz (gerados por TTS ao gravar as definições). */
export const csatPrompt = (tenantId: string) => `csat_${tenantId}`;
export const csatThanksPrompt = (tenantId: string) => `csat_${tenantId}_thanks`;

/** "4", " 5 ", "3." → nota; tudo o resto não é resposta ao inquérito. Pura. */
export function parseScore(text: string): number | null {
  const m = /^\s*([1-5])\s*[.!]?\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

export interface CsatSummary {
  responses: number;
  avg: number | null;
  satisfiedPct: number | null; // % de 4 e 5
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

/** Resumo de notas. Pura. */
export function csatSummary(scores: number[]): CsatSummary {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as CsatSummary["distribution"];
  for (const s of scores) distribution[s as 1] = (distribution[s as 1] ?? 0) + 1;
  const n = scores.length;
  return {
    responses: n,
    avg: n ? Math.round((scores.reduce((a, b) => a + b, 0) / n) * 100) / 100 : null,
    satisfiedPct: n ? Math.round(((distribution[4] + distribution[5]) / n) * 1000) / 10 : null,
    distribution,
  };
}

// ─── Voz ─────────────────────────────────────────────────────────────────────

export async function agentUserOfExtension(tenantId: string, extensionId: string | undefined): Promise<string | null> {
  if (!extensionId) return null;
  return (await prisma.tenantUser.findFirst({ where: { tenantId, extensionId }, select: { id: true } }))?.id ?? null;
}

export async function recordVoiceCsat(p: { tenantId: string; callId: string | null; agentId: string | null; groupId: string | null; score: number }) {
  const call = p.callId ? await prisma.call.findUnique({ where: { id: p.callId }, select: { contactId: true, ticketId: true } }) : null;
  return prisma.csatResponse.create({
    data: {
      tenantId: p.tenantId,
      channel: "VOICE",
      score: p.score,
      callId: p.callId,
      agentId: p.agentId,
      groupId: p.groupId,
      contactId: call?.contactId ?? null,
      ticketId: call?.ticketId ?? null,
      answeredAt: new Date(),
    },
  });
}

// ─── Texto ───────────────────────────────────────────────────────────────────

type ConvRef = { id: string; tenantId: string; inboxId: string; externalRef: string; subject: string | null; contactId: string | null };
type Deliver = (inbox: Inbox, conv: ConvRef, text: string) => Promise<void>;

/** Conversa resolvida: pergunta pelo mesmo canal e deixa a resposta à espera. */
export async function askTextCsat(conversationId: string, deliverText: Deliver, log: FastifyBaseLogger): Promise<void> {
  try {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { inbox: true } });
    if (!conv) return;
    const cfg = await tenantCsatConfig(conv.tenantId);
    if (!cfg.text) return;
    // Uma pergunta por conversa: resolver, reabrir e resolver não pergunta duas vezes.
    if (await prisma.csatResponse.count({ where: { conversationId } })) return;
    await prisma.csatResponse.create({
      data: { tenantId: conv.tenantId, channel: "TEXT", conversationId, agentId: conv.assigneeId, contactId: conv.contactId, ticketId: conv.ticketId },
    });
    await deliverText(conv.inbox, conv, cfg.question);
  } catch (err) {
    log.warn({ err, conversationId }, "csat.text_ask_failed");
  }
}

/**
 * Mensagem a entrar: é a resposta a um inquérito pendente desta pessoa neste
 * canal? Se sim, regista a nota e devolve a conversa (resolvida) e o
 * agradecimento — a mensagem não segue para a IA nem abre conversa nova.
 */
export async function tryTextCsatAnswer(inbox: Inbox, externalRef: string, text: string): Promise<{ conv: ConvRef; thanks: string } | null> {
  const score = parseScore(text);
  if (score === null) return null;
  // Só os inquéritos desta pessoa neste canal (as conversas dela neste inbox).
  const since = new Date(Date.now() - TEXT_WINDOW_MS);
  const convs = await prisma.conversation.findMany({
    where: { inboxId: inbox.id, externalRef, status: "RESOLVED", updatedAt: { gte: since } },
    select: { id: true, tenantId: true, inboxId: true, externalRef: true, subject: true, contactId: true },
  });
  if (!convs.length) return null;
  const pending = await prisma.csatResponse.findFirst({
    where: { tenantId: inbox.tenantId, channel: "TEXT", score: null, createdAt: { gte: since }, conversationId: { in: convs.map((c) => c.id) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, conversationId: true },
  });
  if (!pending) return null;
  const conv = convs.find((c) => c.id === pending.conversationId)!;
  const { count } = await prisma.csatResponse.updateMany({ where: { id: pending.id, score: null }, data: { score, answeredAt: new Date() } });
  return count ? { conv, thanks: (await tenantCsatConfig(inbox.tenantId)).thanks } : null;
}

// ─── SMS ─────────────────────────────────────────────────────────────────────

export const publicApiBase = () => (process.env["PUBLIC_API_URL"] ?? "http://localhost:3000").replace(/\/$/, "");

/** Fim de chamada atendida: link de avaliação por SMS. Nunca lança. */
export async function sendSmsCsat(
  fastify: FastifyInstance,
  call: { id: string; tenantId: string; fromNumber: string | null; contactId: string | null; groupId: string | null; ticketId: string | null },
  agentId: string | null,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    if (!isSmsReachable(call.fromNumber)) return;
    const cfg = await tenantCsatConfig(call.tenantId);
    if (!cfg.sms) return;
    // Quem já respondeu por voz não recebe o SMS.
    if (await prisma.csatResponse.count({ where: { callId: call.id } })) return;
    const token = randomBytes(12).toString("base64url");
    await prisma.csatResponse.create({
      data: { tenantId: call.tenantId, channel: "SMS", callId: call.id, agentId, groupId: call.groupId, contactId: call.contactId, ticketId: call.ticketId, token },
    });
    await sendSms(fastify, call.tenantId, {
      to: call.fromNumber!,
      body: `${cfg.question} ${publicApiBase()}/public/csat/${token}`,
      trigger: CSAT_SMS_TRIGGER,
      ...(call.contactId && { contactId: call.contactId }),
    });
  } catch (err) {
    log.warn({ err, callId: call.id }, "csat.sms_failed");
  }
}
