import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Inbox, type Prisma } from "@falai/db";
import type { UserScope } from "./userScope.js";
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
/** Depois de uma nota baixa, a mensagem seguinte nesta janela é o comentário. */
const COMMENT_WINDOW_MS = 30 * 60_000;
export const LOW_SCORE = 2; // 1 e 2 = insatisfeito: pede-se comentário e vai para a lista da supervisão
export const COMMENT_ASK = "Lamentamos. Se quiser, diga-nos numa mensagem o que correu mal.";
export const COMMENT_THANKS = "Obrigado pelo comentário. Vamos analisar.";
const MAX_COMMENT = 2000;
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

// ─── Relatório ───────────────────────────────────────────────────────────────

/** Âmbito de quem pede: agente só as suas; supervisor os seus agentes e grupos. */
export function csatScopeWhere(scope: UserScope): Prisma.CsatResponseWhereInput {
  if (scope.kind === "SELF") return { agentId: scope.userId };
  if (scope.kind === "TEAM") return { OR: [{ agentId: { in: scope.userIds } }, { groupId: { in: scope.groupIds } }] };
  return {};
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Uma linha por chave (canal, agente, grupo, dia), com o resumo das notas. Pura. */
export function summarizeBy<R extends { score: number }>(rows: R[], key: (r: R) => string | null, names: Map<string, string> = new Map()) {
  return [...new Set(rows.map(key))].map((k) => ({
    key: k,
    name: k ? (names.get(k) ?? k) : null,
    ...csatSummary(rows.filter((r) => key(r) === k).map((r) => r.score)),
  }));
}

// ponytail: no máximo isto de negativas no ecrã/Excel por período; paginar se um cliente passar disto.
const MAX_NEGATIVES = 1000;

export async function buildCsatReport(tenantId: string, scope: UserScope, from: Date, to: Date) {
  const where: Prisma.CsatResponseWhereInput = { tenantId, createdAt: { gte: from, lte: to }, ...csatScopeWhere(scope) };
  const [rows, groups] = await Promise.all([
    prisma.csatResponse.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, channel: true, score: true, agentId: true, groupId: true, createdAt: true, answeredAt: true,
        comment: true, reviewedAt: true, reviewNote: true, reviewedById: true, callId: true, conversationId: true, ticketId: true,
        contactId: true,
      },
    }),
    prisma.extensionGroup.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);
  const answered = rows.filter((r): r is typeof r & { score: number } => r.score !== null);
  const userIds = [...new Set(answered.flatMap((r) => [r.agentId, r.reviewedById]).filter((x): x is string => !!x))];
  const users = new Map((await prisma.tenantUser.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
  const negIds = [...new Set(answered.filter((r) => r.score <= LOW_SCORE && r.contactId).map((r) => r.contactId!))].slice(0, MAX_NEGATIVES);
  const contacts = new Map((await prisma.contact.findMany({ where: { tenantId, id: { in: negIds } }, select: { id: true, name: true, phone: true } })).map((c) => [c.id, c]));
  const byResponses = (a: { responses: number }, b: { responses: number }) => b.responses - a.responses;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    overall: csatSummary(answered.map((r) => r.score)),
    asked: rows.length,
    byChannel: summarizeBy(answered, (r) => r.channel).sort(byResponses),
    byAgent: summarizeBy(answered, (r) => r.agentId, users).sort(byResponses),
    byGroup: summarizeBy(answered, (r) => r.groupId, groupNames).sort(byResponses),
    // Dia da resposta (hora local), do mais antigo para o mais recente.
    byDay: summarizeBy(answered, (r) => localDay(r.answeredAt ?? r.createdAt)).sort((a, b) => (a.key ?? "").localeCompare(b.key ?? "")),
    negatives: answered
      .filter((r) => r.score <= LOW_SCORE)
      .slice(0, MAX_NEGATIVES)
      .map((r) => ({
        id: r.id,
        at: r.answeredAt ?? r.createdAt,
        score: r.score,
        channel: r.channel,
        agent: r.agentId ? (users.get(r.agentId) ?? null) : null,
        group: r.groupId ? (groupNames.get(r.groupId) ?? null) : null,
        contact: r.contactId ? (contacts.get(r.contactId) ?? null) : null,
        comment: r.comment,
        callId: r.callId,
        conversationId: r.conversationId,
        ticketId: r.ticketId,
        reviewedAt: r.reviewedAt,
        reviewedBy: r.reviewedById ? (users.get(r.reviewedById) ?? null) : null,
        reviewNote: r.reviewNote,
      })),
  };
}
export type CsatReport = Awaited<ReturnType<typeof buildCsatReport>>;

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
  // Só os inquéritos desta pessoa neste canal (as conversas dela neste inbox).
  const since = new Date(Date.now() - TEXT_WINDOW_MS);
  const convs = await prisma.conversation.findMany({
    where: { inboxId: inbox.id, externalRef, status: "RESOLVED", updatedAt: { gte: since } },
    select: { id: true, tenantId: true, inboxId: true, externalRef: true, subject: true, contactId: true },
  });
  if (!convs.length) return null;
  if (score === null) return tryTextCsatComment(inbox.tenantId, convs, text);
  const pending = await prisma.csatResponse.findFirst({
    where: { tenantId: inbox.tenantId, channel: "TEXT", score: null, createdAt: { gte: since }, conversationId: { in: convs.map((c) => c.id) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, conversationId: true },
  });
  if (!pending) return null;
  const conv = convs.find((c) => c.id === pending.conversationId)!;
  const { count } = await prisma.csatResponse.updateMany({ where: { id: pending.id, score: null }, data: { score, answeredAt: new Date() } });
  if (!count) return null;
  const thanks = (await tenantCsatConfig(inbox.tenantId)).thanks;
  return { conv, thanks: score <= LOW_SCORE ? `${thanks} ${COMMENT_ASK}` : thanks };
}

/**
 * Mensagem que não é nota: se esta pessoa deu há pouco uma nota baixa sem
 * comentário, é o comentário — fica na avaliação e não abre conversa nova.
 */
async function tryTextCsatComment(tenantId: string, convs: ConvRef[], text: string): Promise<{ conv: ConvRef; thanks: string } | null> {
  const body = text.trim();
  if (!body) return null;
  const low = await prisma.csatResponse.findFirst({
    where: {
      tenantId,
      channel: "TEXT",
      score: { lte: LOW_SCORE },
      comment: null,
      answeredAt: { gte: new Date(Date.now() - COMMENT_WINDOW_MS) },
      conversationId: { in: convs.map((c) => c.id) },
    },
    orderBy: { answeredAt: "desc" },
    select: { id: true, conversationId: true },
  });
  if (!low) return null;
  const { count } = await prisma.csatResponse.updateMany({ where: { id: low.id, comment: null }, data: { comment: body.slice(0, MAX_COMMENT) } });
  return count ? { conv: convs.find((c) => c.id === low.conversationId)!, thanks: COMMENT_THANKS } : null;
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
