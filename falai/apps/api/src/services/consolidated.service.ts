import { prisma, type TicketPriority } from "@falai/db";
import { abandonedIds, avg, callKpis, type CallKpis } from "./attendanceReport.service.js";
import { parseTargets, slaRuleOf, type ServiceTargets } from "./serviceTargets.js";
import { ticketSlaStatus } from "./tickets.service.js";
import { csatSummary } from "./csat.service.js";

/**
 * Relatório consolidado / painel de direcção (centro de atendimento, fase 9) —
 * chamadas, conversas e tickets juntos, por dia/semana/mês e por canal, com os
 * KPIs de topo (SLA, CSAT, QA). É da conta inteira: só para quem vê tudo.
 *
 * As contas são funções puras sobre as linhas do período (consolidated.test.ts).
 */

export type Bucket = "day" | "week" | "month";

const pad = (n: number) => String(n).padStart(2, "0");

/** Chave do período, hora local: 2026-10-06 · semana 2026-10-05 (segunda) · 2026-10. Pura. */
export function bucketKey(d: Date, bucket: Bucket): string {
  if (bucket === "month") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const x = new Date(d);
  if (bucket === "week") x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // volta à segunda
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export interface ConvRow {
  id: string;
  createdAt: Date;
  channel: string;
  status: string;
  /** Primeira mensagem do cliente e primeira resposta (IA ou operador). */
  firstHumanAt: Date | null;
  firstReplyAt: Date | null;
}
export interface TicketRow { createdAt: Date; resolvedAt: Date | null; status: string }

export interface BucketRow {
  period: string;
  callsIn: number;
  callsAnswered: number;
  callsMissed: number;
  callsOut: number;
  conversations: number;
  conversationsResolved: number;
  ticketsCreated: number;
  ticketsResolved: number;
}

const secs = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 1000);

/** Tudo por período. Pura. */
export function bucketRows(
  input: { inbound: { queuedAt: Date | null; answeredAt: Date | null; endedAt: Date | null; startedAt: Date | null; createdAt: Date }[]; outbound: { createdAt: Date }[]; conversations: ConvRow[]; tickets: TicketRow[] },
  bucket: Bucket
): BucketRow[] {
  const rows = new Map<string, BucketRow>();
  const row = (d: Date) => {
    const k = bucketKey(d, bucket);
    let r = rows.get(k);
    if (!r) {
      r = { period: k, callsIn: 0, callsAnswered: 0, callsMissed: 0, callsOut: 0, conversations: 0, conversationsResolved: 0, ticketsCreated: 0, ticketsResolved: 0 };
      rows.set(k, r);
    }
    return r;
  };
  for (const c of input.inbound) {
    const r = row(c.startedAt ?? c.createdAt);
    r.callsIn++;
    if (c.answeredAt) r.callsAnswered++;
    else if (c.queuedAt && c.endedAt) r.callsMissed++;
  }
  for (const c of input.outbound) row(c.createdAt).callsOut++;
  for (const c of input.conversations) {
    const r = row(c.createdAt);
    r.conversations++;
    if (c.status === "RESOLVED") r.conversationsResolved++;
  }
  for (const t of input.tickets) {
    row(t.createdAt).ticketsCreated++;
    if (t.resolvedAt) row(t.resolvedAt).ticketsResolved++;
  }
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/** Contactos por canal: voz (chamadas de entrada) + cada canal de texto. Pura. */
export function volumeByChannel(inboundCalls: number, conversations: ConvRow[]): { channel: string; contacts: number }[] {
  const by = new Map<string, number>([["VOICE", inboundCalls]]);
  for (const c of conversations) by.set(c.channel, (by.get(c.channel) ?? 0) + 1);
  return [...by].map(([channel, contacts]) => ({ channel, contacts })).filter((x) => x.contacts > 0).sort((a, b) => b.contacts - a.contacts);
}

/** Tempo médio até à primeira resposta nas conversas (segundos). Pura. */
export function textFirstResponseSecs(conversations: ConvRow[]): number | null {
  return avg(conversations.filter((c) => c.firstHumanAt && c.firstReplyAt && c.firstReplyAt >= c.firstHumanAt).map((c) => secs(c.firstHumanAt!, c.firstReplyAt!)));
}

export interface TextSla {
  met: number; // 1.ª resposta em menos do limiar
  missed: number; // respondida tarde, ou sem resposta e o limiar já passou
  pending: number; // sem resposta mas ainda dentro do limiar (não conta)
  slaPct: number | null;
}

/**
 * SLA de texto: % das conversas iniciadas pelo cliente com 1.ª resposta (IA
 * ou operador) em menos de `limitSecs`. As ainda à espera dentro do limiar
 * ficam de fora. Pura.
 */
export function textSla(conversations: ConvRow[], limitSecs: number, now = new Date()): TextSla {
  let met = 0, missed = 0, pending = 0;
  for (const c of conversations) {
    if (!c.firstHumanAt) continue;
    const reply = c.firstReplyAt && c.firstReplyAt >= c.firstHumanAt ? c.firstReplyAt : null;
    if (reply) secs(c.firstHumanAt, reply) < limitSecs ? met++ : missed++;
    else secs(c.firstHumanAt, now) < limitSecs ? pending++ : missed++;
  }
  const decided = met + missed;
  return { met, missed, pending, slaPct: decided ? Math.round((met / decided) * 1000) / 10 : null };
}

/** Conversas do período com a 1.ª mensagem do cliente e a 1.ª resposta. */
export async function loadConversations(tenantId: string, range: { gte: Date; lte: Date }, take = MAX_CONVERSATIONS): Promise<ConvRow[]> {
  const convs = await prisma.conversation.findMany({
    where: { tenantId, createdAt: range },
    take,
    select: {
      id: true,
      createdAt: true,
      status: true,
      inbox: { select: { channel: true } },
      messages: { where: { role: { in: ["HUMAN", "AGENT"] } }, orderBy: { seq: "asc" }, take: 20, select: { role: true, createdAt: true } },
    },
  });
  return convs.map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    channel: c.inbox.channel,
    status: c.status,
    firstHumanAt: c.messages.find((m) => m.role === "HUMAN")?.createdAt ?? null,
    firstReplyAt: c.messages.find((m) => m.role === "AGENT")?.createdAt ?? null,
  }));
}

// ─── BD ──────────────────────────────────────────────────────────────────────

// ponytail: tudo em memória até este limite de conversas por pedido; agregar em SQL se um cliente passar disto.
const MAX_CONVERSATIONS = 20_000;

export interface TicketSlaRow {
  priority: TicketPriority;
  targetHours: number | null;
  created: number;
  withDue: number;
  met: number;
  breached: number;
  open: number; // ainda em aberto e dentro do prazo
  slaPct: number | null;
  resolutionSecs: number | null;
}

type TicketSlaInput = { createdAt: Date; resolvedAt: Date | null; dueAt: Date | null; priority: TicketPriority };

/** SLA dos tickets criados no período, no total e por prioridade. Pura. */
export function ticketSlaRows(tickets: TicketSlaInput[], hours: ServiceTargets["ticketHours"], now = new Date()): { total: Omit<TicketSlaRow, "priority" | "targetHours">; byPriority: TicketSlaRow[] } {
  const summarize = (ts: TicketSlaInput[]) => {
    const st = ts.map((t) => ticketSlaStatus(t, now, 0));
    const met = st.filter((x) => x === "MET").length;
    const breached = st.filter((x) => x === "BREACHED").length;
    return {
      created: ts.length,
      withDue: ts.filter((t) => t.dueAt).length,
      met,
      breached,
      open: st.filter((x) => x === "ON_TRACK" || x === "AT_RISK").length,
      slaPct: met + breached ? Math.round((met / (met + breached)) * 1000) / 10 : null,
      resolutionSecs: avg(ts.filter((t) => t.resolvedAt).map((t) => secs(t.createdAt, t.resolvedAt!))),
    };
  };
  return {
    total: summarize(tickets),
    byPriority: (["URGENT", "HIGH", "MEDIUM", "LOW"] as const).map((p) => ({ priority: p, targetHours: hours[p], ...summarize(tickets.filter((t) => t.priority === p)) })),
  };
}

export async function buildConsolidated(tenantId: string, from: Date, to: Date, bucket: Bucket) {
  const range = { gte: from, lte: to };
  const now = new Date();
  const [tenant, inbound, legs, outbound, conversations, tickets, overdueNow, csat, qa] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { serviceTargets: true } }),
    prisma.call.findMany({
      where: { tenantId, kind: "INBOUND", startedAt: range },
      select: { id: true, queuedAt: true, answeredAt: true, endedAt: true, startedAt: true, createdAt: true, groupId: true },
    }),
    prisma.callLeg.findMany({ where: { tenantId, ringStartedAt: range, outcome: "CANCELLED" }, select: { callId: true, outcome: true } }),
    prisma.call.findMany({ where: { tenantId, kind: { not: "INBOUND" }, createdAt: range }, select: { createdAt: true } }),
    loadConversations(tenantId, range),
    prisma.ticket.findMany({
      where: { tenantId, OR: [{ createdAt: range }, { resolvedAt: range }] },
      select: { createdAt: true, resolvedAt: true, status: true, dueAt: true, priority: true },
    }),
    // Atrasados agora (de qualquer data): o que está a falhar neste momento.
    prisma.ticket.count({ where: { tenantId, status: { in: ["OPEN", "PENDING", "ON_HOLD"] }, dueAt: { lt: now } } }),
    prisma.csatResponse.findMany({ where: { tenantId, createdAt: range, score: { not: null } }, select: { score: true } }),
    prisma.qaEvaluation.aggregate({ where: { tenantId, createdAt: range }, _avg: { score: true }, _count: { _all: true } }),
  ]);
  const targets = parseTargets(tenant?.serviceTargets);
  const slaSecs = targets.slaThresholdSecs;
  const rule = slaRuleOf(targets);
  const abandoned = abandonedIds(legs);
  // Tickets criados no período (os resolvidos no período entram na série, não no total).
  const created = tickets.filter((t) => t.createdAt >= from && t.createdAt <= to);
  const calls: CallKpis = callKpis(inbound.filter((c) => c.queuedAt), abandoned, rule);
  const tk = ticketSlaRows(created, targets.ticketHours, now);

  // Por canal: voz com o ASA e o SLA das chamadas; texto com a 1.ª resposta e o SLA de texto.
  const byChannel = volumeByChannel(inbound.length, conversations).map((c) => {
    if (c.channel === "VOICE") return { ...c, firstResponseSecs: calls.tmeSecs, slaPct: calls.slaPct };
    const cs = conversations.filter((x) => x.channel === c.channel);
    return { ...c, firstResponseSecs: textFirstResponseSecs(cs), slaPct: textSla(cs, targets.textSlaSecs, now).slaPct };
  });

  // Série com o SLA de cada período (voz, texto, tickets).
  const series = bucketRows({ inbound, outbound, conversations, tickets }, bucket).map((r) => {
    const inB = <T>(rows: T[], at: (x: T) => Date | null) => rows.filter((x) => { const d = at(x); return d !== null && bucketKey(d, bucket) === r.period; });
    const t = ticketSlaRows(inB(created, (x) => x.createdAt), targets.ticketHours, now).total;
    return {
      ...r,
      callsSlaPct: callKpis(inB(inbound, (c) => c.queuedAt), abandoned, rule).slaPct,
      textSlaPct: textSla(inB(conversations, (c) => c.createdAt), targets.textSlaSecs, now).slaPct,
      ticketsBreached: t.breached,
      ticketSlaPct: t.slaPct,
    };
  });

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucket,
    targets: {
      slaSecs,
      slaTargetPct: targets.slaTargetPct,
      textSlaSecs: targets.textSlaSecs,
      textSlaTargetPct: targets.textSlaTargetPct,
      ticketSlaTargetPct: targets.ticketSlaTargetPct,
    },
    kpis: {
      contacts: inbound.length + conversations.length,
      calls,
      slaSecs,
      callsOut: outbound.length,
      conversations: conversations.length,
      conversationsResolved: conversations.filter((c) => c.status === "RESOLVED").length,
      textFirstResponseSecs: textFirstResponseSecs(conversations),
      textSla: textSla(conversations, targets.textSlaSecs, now),
      ticketsCreated: created.length,
      ticketsResolved: tickets.filter((t) => t.resolvedAt && t.resolvedAt >= from && t.resolvedAt <= to).length,
      ticketResolutionSecs: avg(created.filter((t) => t.resolvedAt).map((t) => secs(t.createdAt, t.resolvedAt!))),
      ticketSla: tk.total,
      ticketsOverdueNow: overdueNow,
      csat: csatSummary(csat.map((r) => r.score!)),
      qa: { evaluations: qa._count._all, avgScore: qa._avg.score === null ? null : Math.round(qa._avg.score * 10) / 10 },
    },
    byChannel,
    ticketsByPriority: tk.byPriority,
    series,
  };
}

export type Consolidated = Awaited<ReturnType<typeof buildConsolidated>>;
