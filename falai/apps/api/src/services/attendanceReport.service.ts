/**
 * Relatórios de atendimento (melhoria 1/4) — KPIs das chamadas de ENTRADA.
 *
 * Duas fontes, ambas do router de entrada (inboundCallRouter.service.ts):
 *   - Call (kind INBOUND) → visão da chamada: atendidas, perdidas, TMA, TME;
 *   - CallLeg            → visão do agente (extensão): resposta, recusas, motivos.
 *
 * Definições (ver SPRINTS.md, Fase 0):
 *   TMA       = média(fim − atendimento), chamadas atendidas
 *   TME       = média(atendimento − início do toque), chamadas atendidas
 *               (não há fila: a "atribuição" é o atendimento)
 *   Resposta  = média(atendimento − início do toque NA PERNA que atendeu)
 *   Perdida   = tocou em extensões e ninguém atendeu; "abandonada" quando quem
 *               ligou desligou a tocar. Quem desliga no IVR não entra (nunca tocou).
 *   Recusada  = perna REJECTED (o agente carregou em "Recusar").
 *   SLA       = % das chamadas terminadas (atendidas + perdidas, sem as
 *               desistências curtas) atendidas em menos do limiar — o do grupo
 *               da chamada ou o geral (serviceTargets.ts; 21 s por omissão).
 *   Desistência curta = perdida em que quem ligou desligou antes de
 *               shortAbandonSecs (5 s por omissão): não conta para o SLA.
 *   ASA       = é o TME acima (velocidade média de atendimento). asaP90Secs =
 *               90 % das atendidas esperaram até este tempo; maxWaitSecs =
 *               maior espera (atendidas e perdidas).
 *
 * Os cálculos são funções puras sobre as linhas do período (testadas em
 * attendanceReport.test.ts). As linhas carregam-se uma vez por pedido e
 * filtram-se em memória — assim a média do tenant (para comparação) sai da
 * mesma leitura.
 * ponytail: período inteiro em memória — folgado até ~200k pernas por pedido;
 * acima disso, agregar em SQL ou num rollup diário (job BullMQ) por trás destas
 * mesmas funções/endpoints.
 */
import { prisma, type CallLegOutcome } from "@falai/db";
import { typingStatus, wrapUpSecs, SUB_PATH_SELECT, subPathName, legUnderCategory, categoryLineage } from "./callTyping.service.js";
import { csatSummary, type CsatSummary } from "./csat.service.js";
import { DEFAULT_SLA_RULE, slaSecsFor, slaTargetFor, tenantTargets, slaRuleOf, type SlaRule, type ServiceTargets } from "./serviceTargets.js";

export { DEFAULT_SLA_SECS } from "./serviceTargets.js";

// ─── Linhas ──────────────────────────────────────────────────────────────────

export interface CallRow {
  id: string;
  queuedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  groupId: string | null;
}

export interface LegRow {
  callId: string;
  extensionId: string | null;
  extensionNumber: string;
  extensionName: string | null;
  groupId: string | null;
  ringStartedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  outcome: CallLegOutcome | null;
  rejectReason: string | null;
  rejectNote: string | null;
  callQueuedAt: Date | null;
  // Tipificação (melhoria 2)
  categoryId?: string | null;
  subcategoryId?: string | null;
  /** Último nível tipificado e os pais dele (ids) — para filtrar por um nível do meio. */
  typingIds?: string[];
  category?: string | null;
  subcategory?: string | null;
  typedAt?: Date | null;
  wrapUpEndsAt?: Date | null;
}

// ─── Cálculos ────────────────────────────────────────────────────────────────

const secs = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 1000;

/** Média arredondada ao segundo; null sem amostras (≠ 0 s). */
export function avg(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
}

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null); // % com 1 casa

/** Percentil pelo método do posto mais próximo, arredondado ao segundo; null sem amostras. */
export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  return Math.round(v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)]!);
}

export interface CallKpis {
  total: number;
  answered: number;
  missed: number;
  abandoned: number; // perdidas em que quem ligou desligou a tocar
  shortAbandoned: number; // dessas, as que desligaram antes de shortAbandonSecs
  answerRate: number | null;
  abandonRate: number | null; // abandonadas (sem as curtas) / terminadas (sem as curtas)
  tmaSecs: number | null;
  tmeSecs: number | null; // = ASA
  asaP90Secs: number | null;
  maxWaitSecs: number | null;
  slaMet: number; // atendidas dentro do limiar
  slaPct: number | null;
}

/**
 * KPIs da chamada. `abandonedCallIds` = chamadas com alguma perna CANCELLED e
 * nenhuma atendida (quem ligou desistiu antes do timeout).
 */
export function callKpis(calls: CallRow[], abandonedCallIds: Set<string>, sla: SlaRule | number = DEFAULT_SLA_RULE): CallKpis {
  const rule: SlaRule = typeof sla === "number" ? { ...DEFAULT_SLA_RULE, secs: sla } : sla;
  const reached = calls.filter((c) => c.queuedAt);
  const answered = reached.filter((c) => c.answeredAt);
  const missed = reached.filter((c) => !c.answeredAt && c.endedAt);
  const abandoned = missed.filter((c) => abandonedCallIds.has(c.id));
  const short = abandoned.filter((c) => secs(c.queuedAt!, c.endedAt!) < rule.shortAbandonSecs).length;
  const waits = answered.map((c) => secs(c.queuedAt!, c.answeredAt!));
  const slaMet = answered.filter((c) => secs(c.queuedAt!, c.answeredAt!) < slaSecsFor(rule, c.groupId)).length;
  const counted = answered.length + missed.length - short;
  return {
    total: reached.length,
    answered: answered.length,
    missed: missed.length,
    abandoned: abandoned.length,
    shortAbandoned: short,
    answerRate: rate(answered.length, answered.length + missed.length),
    abandonRate: rate(abandoned.length - short, counted),
    tmaSecs: avg(answered.filter((c) => c.endedAt).map((c) => secs(c.answeredAt!, c.endedAt!))),
    tmeSecs: avg(waits),
    asaP90Secs: percentile(waits, 90),
    maxWaitSecs: percentile([...waits, ...missed.map((c) => secs(c.queuedAt!, c.endedAt!))], 100),
    slaMet,
    slaPct: rate(slaMet, counted),
  };
}

export interface AgentKpis {
  offered: number; // pernas que tocaram nesta extensão
  answered: number;
  rejected: number;
  noAnswer: number;
  busy: number;
  failed: number;
  cancelled: number; // outro atendeu / quem ligou desligou — não conta contra o agente
  answerRate: number | null;
  rejectRate: number | null;
  tmaSecs: number | null;
  tmeSecs: number | null;
  responseSecs: number | null;
  // Tipificação: só conta o que já não está dentro do prazo (PENDING fica de fora).
  typed: number;
  untyped: number;
  untypedRate: number | null;
  wrapUpSecs: number | null; // pós-chamada — separado do TMA
}

const typingOf = (l: LegRow, now: Date) =>
  typingStatus({ outcome: l.outcome, endedAt: l.endedAt, typedAt: l.typedAt ?? null, wrapUpEndsAt: l.wrapUpEndsAt ?? null }, now);

export function agentKpis(legs: LegRow[], now = new Date()): AgentKpis {
  const by = (o: CallLegOutcome) => legs.filter((l) => l.outcome === o);
  const answered = by("ANSWERED");
  const rejected = by("REJECTED").length;
  const noAnswer = by("NO_ANSWER").length;
  const busy = by("BUSY").length;
  // Só conta o que dependia do agente: tocou e ele atendeu, recusou ou deixou tocar.
  const decided = answered.length + rejected + noAnswer + busy;
  return {
    offered: legs.length,
    answered: answered.length,
    rejected,
    noAnswer,
    busy,
    failed: by("FAILED").length,
    cancelled: by("CANCELLED").length,
    answerRate: rate(answered.length, decided),
    rejectRate: rate(rejected, decided),
    tmaSecs: avg(answered.filter((l) => l.answeredAt && l.endedAt).map((l) => secs(l.answeredAt!, l.endedAt!))),
    tmeSecs: avg(answered.filter((l) => l.answeredAt && l.callQueuedAt).map((l) => secs(l.callQueuedAt!, l.answeredAt!))),
    responseSecs: avg(answered.filter((l) => l.answeredAt).map((l) => secs(l.ringStartedAt, l.answeredAt!))),
    ...typingKpis(answered, now),
  };
}

function typingKpis(answered: LegRow[], now: Date) {
  const statuses = answered.map((l) => typingOf(l, now));
  const typed = statuses.filter((s) => s === "TYPED").length;
  const untyped = statuses.filter((s) => s === "NOT_TYPED").length;
  return {
    typed,
    untyped,
    untypedRate: rate(untyped, typed + untyped),
    wrapUpSecs: avg(
      answered
        .map((l) => wrapUpSecs({ outcome: l.outcome, endedAt: l.endedAt, typedAt: l.typedAt ?? null, wrapUpEndsAt: l.wrapUpEndsAt ?? null }, now))
        .filter((x): x is number => x !== null)
    ),
  };
}

export const UNTYPED = "Não tipificada";

export interface TypingRow {
  category: string;
  subcategory: string | null;
  count: number;
  pct: number;
}

/**
 * Volume por categoria/subcategoria das chamadas atendidas. As que ficaram
 * por tipificar (prazo expirado ou opcional) entram como "Não tipificada";
 * as que ainda estão dentro do prazo não entram.
 */
export function typingBreakdown(legs: LegRow[], now = new Date()): TypingRow[] {
  const counted = legs.filter((l) => {
    const st = typingOf(l, now);
    return st === "TYPED" || st === "NOT_TYPED";
  });
  const counts = new Map<string, TypingRow>();
  for (const l of counted) {
    const cat = l.typedAt ? (l.category ?? "—") : UNTYPED;
    const sub = l.typedAt ? (l.subcategory ?? null) : null;
    const key = `${cat}\u0000${sub ?? ""}`;
    const row = counts.get(key) ?? { category: cat, subcategory: sub, count: 0, pct: 0 };
    row.count++;
    counts.set(key, row);
  }
  return [...counts.values()]
    .map((r) => ({ ...r, pct: rate(r.count, counted.length) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export const OTHER_REASON = "Outro";
export const NO_REASON = "Sem motivo";

export interface ReasonRow {
  reason: string;
  count: number;
  pct: number;
}

/** Recusas por motivo. "Outro" junta os textos livres; "Sem motivo" = recusado no telefone. */
export function reasonBreakdown(legs: LegRow[]): ReasonRow[] {
  const rejected = legs.filter((l) => l.outcome === "REJECTED");
  const counts = new Map<string, number>();
  for (const l of rejected) {
    const key = l.rejectReason ?? (l.rejectNote ? OTHER_REASON : NO_REASON);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, pct: rate(count, rejected.length) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Diferença para a média do tenant (positivo = acima). null quando falta um dos lados. */
export function delta(value: number | null, base: number | null): number | null {
  return value === null || base === null ? null : Math.round((value - base) * 10) / 10;
}

export function abandonedIds(legs: Pick<LegRow, "callId" | "outcome">[]): Set<string> {
  const answered = new Set(legs.filter((l) => l.outcome === "ANSWERED").map((l) => l.callId));
  return new Set(legs.filter((l) => l.outcome === "CANCELLED" && !answered.has(l.callId)).map((l) => l.callId));
}

// ─── Relatório ───────────────────────────────────────────────────────────────

export interface AttendanceFilter {
  from: Date;
  to: Date;
  extensionId?: string | undefined;
  groupId?: string | undefined;
  categoryId?: string | undefined; // tipificação (categoria ou subcategoria)
  /**
   * Âmbito de quem pede (services/userScope.ts): só entram as pernas destas
   * extensões ou destes grupos, e as chamadas desses grupos ou em que tocaram.
   * Ausente = tenant inteiro. O "tenant" do relatório continua a ser a média
   * da conta inteira (é só a referência das comparações).
   */
  scope?: { extensionIds: string[]; groupIds: string[] } | undefined;
}

/** Linha de um período (dia ou hora): volume, SLA e tempos das chamadas. */
export interface PeriodKpis {
  total: number;
  answered: number;
  missed: number;
  abandoned: number;
  shortAbandoned: number;
  answerRate: number | null;
  slaPct: number | null;
  tmaSecs: number | null;
  tmeSecs: number | null;
  asaP90Secs: number | null;
  maxWaitSecs: number | null;
}

const periodOf = (k: CallKpis): PeriodKpis => ({
  total: k.total,
  answered: k.answered,
  missed: k.missed,
  abandoned: k.abandoned,
  shortAbandoned: k.shortAbandoned,
  answerRate: k.answerRate,
  slaPct: k.slaPct,
  tmaSecs: k.tmaSecs,
  tmeSecs: k.tmeSecs,
  asaP90Secs: k.asaP90Secs,
  maxWaitSecs: k.maxWaitSecs,
});

export interface DayRow extends PeriodKpis {
  date: string; // AAAA-MM-DD
  responseSecs: number | null;
  wrapUpSecs: number | null;
}

/** Chamadas/SLA/TMA/ASA por dia da chamada e resposta/pós-chamada por dia da perna. */
export function dailyRows(calls: CallRow[], legs: LegRow[], now = new Date(), abandoned = new Set<string>(), sla: SlaRule = DEFAULT_SLA_RULE): DayRow[] {
  // Dia local (como os intervalos dos relatórios) — ver localDay em reportsOverview.
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const callsBy = groupByKey(calls.filter((c) => c.queuedAt), (c) => day(c.queuedAt!));
  const legsBy = groupByKey(legs, (l) => day(l.ringStartedAt));
  const days = [...new Set([...callsBy.keys(), ...legsBy.keys()])].sort();
  return days.map((date) => {
    const c = callKpis(callsBy.get(date) ?? [], abandoned, sla);
    const a = agentKpis(legsBy.get(date) ?? [], now);
    return { date, ...periodOf(c), responseSecs: a.responseSecs, wrapUpSecs: a.wrapUpSecs };
  });
}

export interface HourRow extends PeriodKpis {
  hour: number; // 0–23, hora local em que a chamada começou a tocar
}

/** As 24 horas do dia (todas, mesmo sem chamadas — o gráfico fica completo). */
export function hourlyRows(calls: CallRow[], abandoned = new Set<string>(), sla: SlaRule = DEFAULT_SLA_RULE): HourRow[] {
  const by = groupByKey(calls.filter((c) => c.queuedAt), (c) => String(c.queuedAt!.getHours()));
  return Array.from({ length: 24 }, (_, hour) => ({ hour, ...periodOf(callKpis(by.get(String(hour)) ?? [], abandoned, sla)) }));
}

/**
 * Mapa de calor: chamadas por dia da semana × hora. [0] = segunda … [6] =
 * domingo; cada linha tem 24 horas. Mostra onde faltam agentes.
 */
export function weekdayHourGrid(calls: CallRow[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const c of calls) {
    if (!c.queuedAt) continue;
    grid[(c.queuedAt.getDay() + 6) % 7]![c.queuedAt.getHours()]!++;
  }
  return grid;
}

export interface AgentRow extends AgentKpis {
  extensionId: string | null;
  number: string;
  name: string | null;
  /** Satisfação do utilizador desta extensão (todos os canais), no período. */
  csatAvg: number | null;
  csatResponses: number;
  vsTenant: { answerRate: number | null; rejectRate: number | null; tmaSecs: number | null; responseSecs: number | null };
}

export interface GroupRow extends CallKpis {
  groupId: string | null;
  name: string;
  rejected: number;
  /** Limiar e meta do SLA deste grupo (os do grupo ou os gerais). */
  slaSecs: number;
  slaTargetPct: number | null;
  vsTenant: { answerRate: number | null; tmaSecs: number | null; tmeSecs: number | null; slaPct: number | null };
}

export interface AttendanceReport {
  from: string;
  to: string;
  /** Sem PBX nosso (CRM_BYO_PBX): só há o CDR do Yeastar — sem agentes, grupos nem recusas. */
  limited: boolean;
  tenant: { calls: CallKpis; agents: AgentKpis };
  /** Igual a `tenant` sem filtro; com agente/grupo, os números desse agente/grupo. */
  selection: { calls: CallKpis; agents: AgentKpis };
  reasons: ReasonRow[];
  typing: TypingRow[];
  /** Por dia (selecção): tendências (SLA, ASA, volume) e mini-tendências do Resumo. */
  byDay: DayRow[];
  /** As 24 horas (selecção). */
  byHour: HourRow[];
  /** Chamadas por dia da semana (0 = segunda) × hora (selecção). */
  byWeekdayHour: number[][];
  byAgent: AgentRow[];
  byGroup: GroupRow[];
  /** Limiar do SLA usado (segundos) — o do grupo filtrado, se tiver. */
  slaSecs: number;
  /** Meta do SLA (%) — a do grupo filtrado, se tiver; null = sem meta. */
  slaTargetPct: number | null;
  /** Desistências abaixo disto não contam para o SLA (0 = contam todas). */
  shortAbandonSecs: number;
  /** Satisfação da selecção (agente/grupo/âmbito; todos os canais). */
  csat: CsatSummary;
  /** A mesma selecção no período anterior com a mesma duração (só com withPrevious). */
  previous?: { from: string; to: string; calls: CallKpis; agents: AgentKpis; csat: CsatSummary };
}

/** Período anterior com a mesma duração, a acabar logo antes de `from`. */
export function previousPeriod(from: Date, to: Date): { from: Date; to: Date } {
  const prevTo = new Date(from.getTime() - 1);
  return { from: new Date(prevTo.getTime() - (to.getTime() - from.getTime())), to: prevTo };
}

/** Relatório do período e, junto, a mesma selecção no período anterior (para as variações). */
export async function buildAttendanceWithPrevious(tenantId: string, f: AttendanceFilter, opts: { limited: boolean }): Promise<AttendanceReport> {
  const p = previousPeriod(f.from, f.to);
  const [cur, prev] = await Promise.all([buildAttendanceReport(tenantId, f, opts), buildAttendanceReport(tenantId, { ...f, ...p }, opts)]);
  return { ...cur, previous: { from: prev.from, to: prev.to, calls: prev.selection.calls, agents: prev.selection.agents, csat: prev.csat } };
}

/** Nota de satisfação com o agente (extensão do utilizador que atendeu). */
export interface CsatRow { score: number; extensionId: string | null; groupId: string | null; callId: string | null }

/** Satisfação da selecção: as do agente, do grupo, das chamadas filtradas ou do âmbito. Pura. */
export function selectCsat(rows: CsatRow[], f: Pick<AttendanceFilter, "extensionId" | "groupId" | "categoryId" | "scope">, callIds: Set<string>): CsatRow[] {
  return rows.filter((r) => {
    if (f.scope && !((r.extensionId !== null && f.scope.extensionIds.includes(r.extensionId)) || (r.groupId !== null && f.scope.groupIds.includes(r.groupId)))) return false;
    if (f.extensionId && r.extensionId !== f.extensionId) return false;
    if (f.groupId && r.groupId !== f.groupId) return false;
    // Tipificação só existe nas chamadas: fica a satisfação dessas chamadas.
    if (f.categoryId && !(r.callId && callIds.has(r.callId))) return false;
    return true;
  });
}

async function loadCsat(tenantId: string, from: Date, to: Date): Promise<CsatRow[]> {
  const [rows, users] = await Promise.all([
    prisma.csatResponse.findMany({ where: { tenantId, createdAt: { gte: from, lte: to }, score: { not: null } }, select: { score: true, agentId: true, groupId: true, callId: true } }),
    prisma.tenantUser.findMany({ where: { tenantId, extensionId: { not: null } }, select: { id: true, extensionId: true } }),
  ]);
  const ext = new Map(users.map((u) => [u.id, u.extensionId]));
  return rows.map((r) => ({ score: r.score!, extensionId: r.agentId ? (ext.get(r.agentId) ?? null) : null, groupId: r.groupId, callId: r.callId }));
}

async function loadRows(tenantId: string, from: Date, to: Date): Promise<{ calls: CallRow[]; legs: LegRow[] }> {
  const [calls, legs] = await Promise.all([
    prisma.call.findMany({
      where: { tenantId, kind: "INBOUND", startedAt: { gte: from, lte: to }, queuedAt: { not: null } },
      select: { id: true, queuedAt: true, answeredAt: true, endedAt: true, groupId: true },
    }),
    prisma.callLeg.findMany({
      where: { tenantId, ringStartedAt: { gte: from, lte: to } },
      select: {
        callId: true,
        extensionId: true,
        extensionNumber: true,
        groupId: true,
        ringStartedAt: true,
        answeredAt: true,
        endedAt: true,
        outcome: true,
        rejectNote: true,
        extension: { select: { displayName: true } },
        rejectReason: { select: { label: true } },
        call: { select: { queuedAt: true } },
        categoryId: true,
        subcategoryId: true,
        typedAt: true,
        wrapUpEndsAt: true,
        category: { select: { name: true } },
        subcategory: { select: SUB_PATH_SELECT },
      },
    }),
  ]);
  const tree = await prisma.callCategory.findMany({ where: { tenantId }, select: { id: true, parentId: true } });
  const lineage = (id: string | null) => (id ? categoryLineage(tree, id) : []);
  return {
    calls,
    legs: legs.map((l) => ({
      callId: l.callId,
      extensionId: l.extensionId,
      extensionNumber: l.extensionNumber,
      extensionName: l.extension?.displayName ?? null,
      groupId: l.groupId,
      ringStartedAt: l.ringStartedAt,
      answeredAt: l.answeredAt,
      endedAt: l.endedAt,
      outcome: l.outcome,
      rejectReason: l.rejectReason?.label ?? null,
      rejectNote: l.rejectNote,
      callQueuedAt: l.call.queuedAt,
      categoryId: l.categoryId,
      subcategoryId: l.subcategoryId,
      category: l.category?.name ?? null,
      subcategory: subPathName(l.subcategory) ?? null,
      typingIds: lineage(l.subcategoryId),
      typedAt: l.typedAt,
      wrapUpEndsAt: l.wrapUpEndsAt,
    })),
  };
}

/** Relatório completo do período. Isolado por tenant em todas as leituras. */
/** Âmbito de quem pede: pernas das extensões/grupos dele e chamadas em que tocaram ou desses grupos. */
export function scopeRows(calls: CallRow[], legs: LegRow[], scope: { extensionIds: string[]; groupIds: string[] }) {
  const exts = new Set(scope.extensionIds);
  const groups = new Set(scope.groupIds);
  const inLegs = legs.filter((l) => (l.extensionId !== null && exts.has(l.extensionId)) || (l.groupId !== null && groups.has(l.groupId)));
  const ids = new Set(inLegs.map((l) => l.callId));
  return { calls: calls.filter((c) => ids.has(c.id) || (c.groupId !== null && groups.has(c.groupId))), legs: inLegs };
}

export async function buildAttendanceReport(
  tenantId: string,
  f: AttendanceFilter,
  opts: { limited: boolean }
): Promise<AttendanceReport> {
  if (opts.limited) return byoReport(tenantId, f);

  const [{ calls, legs }, targets, csatRows] = await Promise.all([loadRows(tenantId, f.from, f.to), tenantTargets(tenantId), loadCsat(tenantId, f.from, f.to)]);
  const abandoned = abandonedIds(legs);
  const sla = slaRuleOf(targets);
  const tenant = { calls: callKpis(calls, abandoned, sla), agents: agentKpis(legs) };

  // Selecção: um grupo filtra chamadas e pernas desse grupo; um agente filtra
  // as pernas dele e as chamadas em que tocou.
  let selCalls = calls;
  let selLegs = legs;
  if (f.scope) ({ calls: selCalls, legs: selLegs } = scopeRows(calls, legs, f.scope));
  if (f.groupId) {
    selCalls = selCalls.filter((c) => c.groupId === f.groupId);
    selLegs = selLegs.filter((l) => l.groupId === f.groupId);
  }
  if (f.extensionId) {
    selLegs = selLegs.filter((l) => l.extensionId === f.extensionId);
    const ids = new Set(selLegs.map((l) => l.callId));
    selCalls = selCalls.filter((c) => ids.has(c.id));
  }
  // Tipificação: só as chamadas atendidas com esta categoria (ou subcategoria).
  if (f.categoryId) {
    // Um nível do meio apanha tudo o que está por baixo dele (typingIds = último nível + pais).
    selLegs = selLegs.filter((l) => l.categoryId === f.categoryId || (l.typingIds ?? [l.subcategoryId]).includes(f.categoryId!));
    const ids = new Set(selLegs.map((l) => l.callId));
    selCalls = selCalls.filter((c) => ids.has(c.id));
  }

  const groupNames = new Map(
    (await prisma.extensionGroup.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((g) => [g.id, g.name])
  );

  return {
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    limited: false,
    tenant,
    selection: { calls: callKpis(selCalls, abandoned, sla), agents: agentKpis(selLegs) },
    reasons: reasonBreakdown(selLegs),
    typing: typingBreakdown(selLegs),
    byDay: dailyRows(selCalls, selLegs, new Date(), abandoned, sla),
    byHour: hourlyRows(selCalls, abandoned, sla),
    byWeekdayHour: weekdayHourGrid(selCalls),
    byAgent: agentRows(selLegs, tenant.agents, csatRows),
    byGroup: groupRows(selCalls, selLegs, groupNames, abandoned, tenant.calls, sla, targets),
    slaSecs: slaSecsFor(sla, f.groupId ?? null),
    slaTargetPct: slaTargetFor(targets, f.groupId ?? null),
    shortAbandonSecs: sla.shortAbandonSecs,
    csat: csatSummary(selectCsat(csatRows, f, new Set(selCalls.map((c) => c.id))).map((r) => r.score)),
  };
}

function groupByKey<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function agentRows(legs: LegRow[], base: AgentKpis, csat: CsatRow[] = []): AgentRow[] {
  const csatBy = groupByKey(csat.filter((r) => r.extensionId), (r) => r.extensionId!);
  // Por extensionId; extensões apagadas ficam agrupadas pelo número guardado.
  return [...groupByKey(legs, (l) => l.extensionId ?? `#${l.extensionNumber}`).values()]
    .map((ls) => {
      const k = agentKpis(ls);
      const first = ls[0]!;
      return {
        extensionId: first.extensionId,
        number: first.extensionNumber,
        name: first.extensionName,
        ...k,
        csatAvg: first.extensionId ? csatSummary((csatBy.get(first.extensionId) ?? []).map((r) => r.score)).avg : null,
        csatResponses: first.extensionId ? (csatBy.get(first.extensionId)?.length ?? 0) : 0,
        vsTenant: {
          answerRate: delta(k.answerRate, base.answerRate),
          rejectRate: delta(k.rejectRate, base.rejectRate),
          tmaSecs: delta(k.tmaSecs, base.tmaSecs),
          responseSecs: delta(k.responseSecs, base.responseSecs),
        },
      };
    })
    .sort((a, b) => b.offered - a.offered || a.number.localeCompare(b.number));
}

export function groupRows(
  calls: CallRow[],
  legs: LegRow[],
  names: Map<string, string>,
  abandoned: Set<string>,
  base: CallKpis,
  sla: SlaRule = DEFAULT_SLA_RULE,
  targets?: ServiceTargets
): GroupRow[] {
  const legsByGroup = groupByKey(legs, (l) => l.groupId ?? "");
  return [...groupByKey(calls, (c) => c.groupId ?? "").entries()]
    .map(([gid, cs]) => {
      const k = callKpis(cs, abandoned, sla);
      return {
        groupId: gid || null,
        name: gid ? (names.get(gid) ?? "—") : "Directas",
        ...k,
        rejected: (legsByGroup.get(gid) ?? []).filter((l) => l.outcome === "REJECTED").length,
        slaSecs: slaSecsFor(sla, gid || null),
        slaTargetPct: targets ? slaTargetFor(targets, gid || null) : null,
        vsTenant: {
          answerRate: delta(k.answerRate, base.answerRate),
          tmaSecs: delta(k.tmaSecs, base.tmaSecs),
          tmeSecs: delta(k.tmeSecs, base.tmeSecs),
          slaPct: delta(k.slaPct, base.slaPct),
        },
      };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * Cliente com PBX próprio (Yeastar): só o CDR sincronizado. Atendidas/perdidas
 * e TMA (talkSecs); tempo de toque como TME aproximado. Sem agentes nem recusas.
 */
async function byoReport(tenantId: string, f: AttendanceFilter): Promise<AttendanceReport> {
  const rows = await prisma.pbxCall.findMany({
    where: { tenantId, callType: "Inbound", startedAt: { gte: f.from, lte: f.to } },
    select: { disposition: true, talkSecs: true, ringSecs: true },
  });
  const answered = rows.filter((r) => r.disposition.toUpperCase() === "ANSWERED");
  const missed = rows.length - answered.length;
  const targets = await tenantTargets(tenantId);
  const slaSecs = targets.slaThresholdSecs;
  const slaMet = answered.filter((r) => r.ringSecs < slaSecs).length;
  const calls: CallKpis = {
    total: rows.length,
    answered: answered.length,
    missed,
    abandoned: 0,
    shortAbandoned: 0,
    answerRate: rate(answered.length, rows.length),
    abandonRate: null,
    tmaSecs: avg(answered.map((r) => r.talkSecs)),
    tmeSecs: avg(answered.map((r) => r.ringSecs)),
    asaP90Secs: percentile(answered.map((r) => r.ringSecs), 90),
    maxWaitSecs: percentile(answered.map((r) => r.ringSecs), 100),
    slaMet,
    slaPct: rate(slaMet, rows.length),
  };
  const agents = agentKpis([]);
  return {
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    limited: true,
    tenant: { calls, agents },
    selection: { calls, agents },
    reasons: [],
    typing: [],
    byDay: [],
    byHour: [],
    byWeekdayHour: [],
    byAgent: [],
    byGroup: [],
    slaSecs,
    slaTargetPct: targets.slaTargetPct,
    shortAbandonSecs: 0,
    csat: csatSummary(selectCsat(await loadCsat(tenantId, f.from, f.to), f, new Set()).map((r) => r.score)),
  };
}

// ─── Lista de chamadas (com pernas) ──────────────────────────────────────────

export async function listAttendanceCalls(
  tenantId: string,
  f: AttendanceFilter,
  page: number,
  pageSize: number
) {
  const where = {
    tenantId,
    kind: "INBOUND" as const,
    startedAt: { gte: f.from, lte: f.to },
    queuedAt: { not: null },
    ...(f.groupId && { groupId: f.groupId }),
    ...(f.scope && {
      OR: [{ groupId: { in: f.scope.groupIds } }, { legs: { some: { extensionId: { in: f.scope.extensionIds } } } }],
    }),
    ...((f.extensionId || f.categoryId) && {
      legs: {
        some: {
          ...(f.extensionId && { extensionId: f.extensionId }),
          ...(f.categoryId && legUnderCategory(f.categoryId)),
        },
      },
    }),
  };
  const [total, rows] = await Promise.all([
    prisma.call.count({ where }),
    prisma.call.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        fromNumber: true,
        toNumber: true,
        contactId: true,
        contact: { select: { name: true } },
        startedAt: true,
        queuedAt: true,
        answeredAt: true,
        endedAt: true,
        group: { select: { name: true } },
        legs: {
          orderBy: { ringStartedAt: "asc" },
          select: {
            extensionNumber: true,
            outcome: true,
            ringStartedAt: true,
            answeredAt: true,
            rejectNote: true,
            rejectReason: { select: { label: true } },
            category: { select: { name: true } },
            subcategory: { select: SUB_PATH_SELECT },
            typingNote: true,
          },
        },
      },
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    data: rows.map((c) => ({
      id: c.id,
      from: c.fromNumber,
      to: c.toNumber,
      contactId: c.contactId,
      contactName: c.contact?.name ?? null,
      startedAt: c.startedAt,
      group: c.group?.name ?? null,
      answered: c.answeredAt !== null,
      waitSecs: c.queuedAt && c.answeredAt ? Math.round(secs(c.queuedAt, c.answeredAt)) : null,
      talkSecs: c.answeredAt && c.endedAt ? Math.round(secs(c.answeredAt, c.endedAt)) : null,
      legs: c.legs.map((l) => ({
        extension: l.extensionNumber,
        outcome: l.outcome,
        responseSecs: l.answeredAt ? Math.round(secs(l.ringStartedAt, l.answeredAt)) : null,
        reason: l.rejectReason?.label ?? l.rejectNote ?? null,
        typing: l.category ? [l.category.name, subPathName(l.subcategory)].filter(Boolean).join(" › ") : null,
        typingNote: l.typingNote,
      })),
    })),
  };
}

// ─── Exportação ──────────────────────────────────────────────────────────────

export type ExportView = "attendance" | "agents" | "groups" | "reasons" | "typing" | "calls";
export type AttendanceCallRow = Awaited<ReturnType<typeof listAttendanceCalls>>["data"][number];

/** Tabela (cabeçalho + linhas) de uma vista — serve o CSV e o Excel. */
export function exportTable(report: AttendanceReport, view: "agents" | "groups" | "reasons" | "typing"): (string | number | null)[][] {
  if (view === "agents") {
    return [
      ["Extensão", "Nome", "Tocou", "Atendeu", "Recusou", "Não atendeu", "Ocupado", "% atendimento", "% recusa", "TMA (s)", "ASA (s)", "Resposta (s)", "Δ TMA vs média", "Δ resposta vs média", "Tipificadas", "Não tipificadas", "% não tipificadas", "Pós-chamada (s)", "Satisfação (média)", "Respostas de satisfação"],
      ...report.byAgent.map((r) => [
        r.number, r.name, r.offered, r.answered, r.rejected, r.noAnswer, r.busy, r.answerRate, r.rejectRate,
        r.tmaSecs, r.tmeSecs, r.responseSecs, r.vsTenant.tmaSecs, r.vsTenant.responseSecs,
        r.typed, r.untyped, r.untypedRate, r.wrapUpSecs, r.csatAvg, r.csatResponses,
      ]),
    ];
  }
  if (view === "groups") {
    return [
      ["Grupo", "Chamadas", "Atendidas", "Perdidas", "Abandonadas", "Desistências curtas", "Recusas", "SLA %", "Meta SLA %", "Limiar SLA (s)", "% atendimento", "% abandono", "TMA (s)", "ASA (s)", "ASA 90% (s)", "Maior espera (s)", "Δ TMA vs média", "Δ ASA vs média"],
      ...report.byGroup.map((r) => [
        r.name, r.total, r.answered, r.missed, r.abandoned, r.shortAbandoned, r.rejected, r.slaPct, r.slaTargetPct, r.slaSecs, r.answerRate, r.abandonRate,
        r.tmaSecs, r.tmeSecs, r.asaP90Secs, r.maxWaitSecs, r.vsTenant.tmaSecs, r.vsTenant.tmeSecs,
      ]),
    ];
  }
  if (view === "typing") {
    return [["Categoria", "Subcategoria", "Chamadas", "%"], ...report.typing.map((r) => [r.category, r.subcategory, r.count, r.pct])];
  }
  return [["Motivo", "Recusas", "%"], ...report.reasons.map((r) => [r.reason, r.count, r.pct])];
}

export function tableToCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}
