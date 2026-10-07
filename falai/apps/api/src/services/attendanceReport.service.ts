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
 *   SLA       = % das chamadas terminadas (atendidas + perdidas) atendidas em
 *               menos de slaSecs (21 por omissão; meta do cliente em serviceTargets).
 *   ASA       = é o TME acima (velocidade média de atendimento).
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
import { typingStatus, wrapUpSecs } from "./callTyping.service.js";

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

export interface CallKpis {
  total: number;
  answered: number;
  missed: number;
  abandoned: number; // perdidas em que quem ligou desligou a tocar
  answerRate: number | null;
  tmaSecs: number | null;
  tmeSecs: number | null;
  slaPct: number | null;
}

export const DEFAULT_SLA_SECS = 21;

/**
 * KPIs da chamada. `abandonedCallIds` = chamadas com alguma perna CANCELLED e
 * nenhuma atendida (quem ligou desistiu antes do timeout).
 */
export function callKpis(calls: CallRow[], abandonedCallIds: Set<string>, slaSecs = DEFAULT_SLA_SECS): CallKpis {
  const reached = calls.filter((c) => c.queuedAt);
  const answered = reached.filter((c) => c.answeredAt);
  const missed = reached.filter((c) => !c.answeredAt && c.endedAt);
  return {
    total: reached.length,
    answered: answered.length,
    missed: missed.length,
    abandoned: missed.filter((c) => abandonedCallIds.has(c.id)).length,
    answerRate: rate(answered.length, answered.length + missed.length),
    tmaSecs: avg(answered.filter((c) => c.endedAt).map((c) => secs(c.answeredAt!, c.endedAt!))),
    tmeSecs: avg(answered.map((c) => secs(c.queuedAt!, c.answeredAt!))),
    slaPct: rate(answered.filter((c) => secs(c.queuedAt!, c.answeredAt!) < slaSecs).length, answered.length + missed.length),
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

export interface DayRow {
  date: string; // AAAA-MM-DD
  tmaSecs: number | null;
  tmeSecs: number | null;
  responseSecs: number | null;
  wrapUpSecs: number | null;
}

/** TMA/TME por dia da chamada e resposta/pós-chamada por dia da perna. */
export function dailyRows(calls: CallRow[], legs: LegRow[], now = new Date()): DayRow[] {
  // Dia local (como os intervalos dos relatórios) — ver localDay em reportsOverview.
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const callsBy = groupByKey(calls.filter((c) => c.queuedAt), (c) => day(c.queuedAt!));
  const legsBy = groupByKey(legs, (l) => day(l.ringStartedAt));
  const days = [...new Set([...callsBy.keys(), ...legsBy.keys()])].sort();
  return days.map((date) => {
    const c = callKpis(callsBy.get(date) ?? [], new Set());
    const a = agentKpis(legsBy.get(date) ?? [], now);
    return { date, tmaSecs: c.tmaSecs, tmeSecs: c.tmeSecs, responseSecs: a.responseSecs, wrapUpSecs: a.wrapUpSecs };
  });
}

export interface AgentRow extends AgentKpis {
  extensionId: string | null;
  number: string;
  name: string | null;
  vsTenant: { answerRate: number | null; rejectRate: number | null; tmaSecs: number | null; responseSecs: number | null };
}

export interface GroupRow extends CallKpis {
  groupId: string | null;
  name: string;
  rejected: number;
  vsTenant: { answerRate: number | null; tmaSecs: number | null; tmeSecs: number | null };
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
  /** Por dia (selecção): para as mini-tendências dos cartões do Resumo. */
  byDay: DayRow[];
  byAgent: AgentRow[];
  byGroup: GroupRow[];
  /** Limiar do SLA usado (segundos). */
  slaSecs: number;
}

/** Limiar do SLA do cliente (metas em Tenant.serviceTargets). */
async function tenantSlaSecs(tenantId: string): Promise<number> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { serviceTargets: true } });
  const v = (t?.serviceTargets as { slaThresholdSecs?: unknown } | null)?.slaThresholdSecs;
  return typeof v === "number" && v > 0 ? v : DEFAULT_SLA_SECS;
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
        subcategory: { select: { name: true } },
      },
    }),
  ]);
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
      subcategory: l.subcategory?.name ?? null,
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

  const { calls, legs } = await loadRows(tenantId, f.from, f.to);
  const abandoned = abandonedIds(legs);
  const slaSecs = await tenantSlaSecs(tenantId);
  const tenant = { calls: callKpis(calls, abandoned, slaSecs), agents: agentKpis(legs) };

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
    selLegs = selLegs.filter((l) => l.categoryId === f.categoryId || l.subcategoryId === f.categoryId);
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
    selection: { calls: callKpis(selCalls, abandoned, slaSecs), agents: agentKpis(selLegs) },
    reasons: reasonBreakdown(selLegs),
    typing: typingBreakdown(selLegs),
    byDay: dailyRows(selCalls, selLegs),
    byAgent: agentRows(selLegs, tenant.agents),
    byGroup: groupRows(selCalls, selLegs, groupNames, abandoned, tenant.calls, slaSecs),
    slaSecs,
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

export function agentRows(legs: LegRow[], base: AgentKpis): AgentRow[] {
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
  slaSecs = DEFAULT_SLA_SECS
): GroupRow[] {
  const legsByGroup = groupByKey(legs, (l) => l.groupId ?? "");
  return [...groupByKey(calls, (c) => c.groupId ?? "").entries()]
    .map(([gid, cs]) => {
      const k = callKpis(cs, abandoned, slaSecs);
      return {
        groupId: gid || null,
        name: gid ? (names.get(gid) ?? "—") : "Directas",
        ...k,
        rejected: (legsByGroup.get(gid) ?? []).filter((l) => l.outcome === "REJECTED").length,
        vsTenant: {
          answerRate: delta(k.answerRate, base.answerRate),
          tmaSecs: delta(k.tmaSecs, base.tmaSecs),
          tmeSecs: delta(k.tmeSecs, base.tmeSecs),
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
  const slaSecs = await tenantSlaSecs(tenantId);
  const calls: CallKpis = {
    total: rows.length,
    answered: answered.length,
    missed,
    abandoned: 0,
    answerRate: rate(answered.length, rows.length),
    tmaSecs: avg(answered.map((r) => r.talkSecs)),
    tmeSecs: avg(answered.map((r) => r.ringSecs)),
    slaPct: rate(answered.filter((r) => r.ringSecs < slaSecs).length, rows.length),
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
    byAgent: [],
    byGroup: [],
    slaSecs,
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
          ...(f.categoryId && { OR: [{ categoryId: f.categoryId }, { subcategoryId: f.categoryId }] }),
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
            subcategory: { select: { name: true } },
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
        typing: l.category ? [l.category.name, l.subcategory?.name].filter(Boolean).join(" › ") : null,
        typingNote: l.typingNote,
      })),
    })),
  };
}

// ─── Exportação ──────────────────────────────────────────────────────────────

export type ExportView = "agents" | "groups" | "reasons" | "typing";

/** Tabela (cabeçalho + linhas) de uma vista — serve o CSV e o Excel. */
export function exportTable(report: AttendanceReport, view: ExportView): (string | number | null)[][] {
  if (view === "agents") {
    return [
      ["Extensão", "Nome", "Tocou", "Atendeu", "Recusou", "Não atendeu", "Ocupado", "% atendimento", "% recusa", "TMA (s)", "TME (s)", "Resposta (s)", "Δ TMA vs média", "Δ resposta vs média", "Tipificadas", "Não tipificadas", "% não tipificadas", "Pós-chamada (s)"],
      ...report.byAgent.map((r) => [
        r.number, r.name, r.offered, r.answered, r.rejected, r.noAnswer, r.busy, r.answerRate, r.rejectRate,
        r.tmaSecs, r.tmeSecs, r.responseSecs, r.vsTenant.tmaSecs, r.vsTenant.responseSecs,
        r.typed, r.untyped, r.untypedRate, r.wrapUpSecs,
      ]),
    ];
  }
  if (view === "groups") {
    return [
      ["Grupo", "Chamadas", "Atendidas", "Perdidas", "Abandonadas", "Recusas", "% atendimento", "TMA (s)", "TME (s)", "Δ TMA vs média", "Δ TME vs média"],
      ...report.byGroup.map((r) => [
        r.name, r.total, r.answered, r.missed, r.abandoned, r.rejected, r.answerRate, r.tmaSecs, r.tmeSecs, r.vsTenant.tmaSecs, r.vsTenant.tmeSecs,
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
