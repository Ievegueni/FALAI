import { prisma } from "@falai/db";
import type { UserScope } from "./userScope.js";
import { typingStatus, wrapUpSecs } from "./callTyping.service.js";

/**
 * Tempo dos agentes (centro de atendimento, fase 5) — ver
 * docs/PLANO-CENTRO-ATENDIMENTO.md.
 *
 *   Escalado  = soma dos turnos (Shift) no período
 *   Ligado    = sessões no CRM (AgentSession), sobreposições juntas (vários separadores)
 *   Aderência = % do escalado em que esteve ligado
 *   Pausa     = pausas da extensão (AgentPause), por motivo
 *   Conversa  = pernas atendidas pela extensão do agente (CallLeg)
 *   Pós-chamada = do fim da chamada à tipificação (ver callTyping.service.ts)
 *   Disponível = ligado sem estar em pausa, em conversa nem em pós-chamada
 *
 * Os cálculos são funções puras sobre intervalos (testadas em agentTime.test.ts).
 */

export type Interval = [number, number]; // ms

/** Junta intervalos sobrepostos e corta-os ao período. */
export function mergeIntervals(list: Interval[], from: number, to: number): Interval[] {
  const clipped = list
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as Interval)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of clipped) {
    const last = out.at(-1);
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}

export const totalSecs = (list: Interval[]) => Math.round(list.reduce((s, [a, b]) => s + (b - a), 0) / 1000);

/** Tempo comum entre dois conjuntos já juntos (ordenados, sem sobreposições). */
export function overlapSecs(a: Interval[], b: Interval[]): number {
  let ms = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0], b[j]![0]);
    const hi = Math.min(a[i]![1], b[j]![1]);
    if (hi > lo) ms += hi - lo;
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return Math.round(ms / 1000);
}

/** Turnos semanais → intervalos concretos dos dias do período (hora local). */
export function shiftIntervals(shifts: { weekday: number; startMin: number; endMin: number }[], from: Date, to: Date): Interval[] {
  const out: Interval[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (; day <= to; day.setDate(day.getDate() + 1)) {
    for (const s of shifts) {
      if (s.weekday !== day.getDay()) continue;
      const start = new Date(day);
      start.setMinutes(s.startMin);
      const end = new Date(day);
      end.setMinutes(s.endMin);
      out.push([start.getTime(), end.getTime()]);
    }
  }
  return mergeIntervals(out, from.getTime(), to.getTime());
}

export interface AgentTimeRow {
  userId: string;
  name: string;
  scheduledSecs: number;
  loggedSecs: number;
  loggedInShiftSecs: number;
  adherencePct: number | null;
  pausedSecs: number;
  pauses: { reason: string | null; secs: number; count: number }[];
  talkSecs: number;
  wrapUpSecs: number;
  availableSecs: number;
}

export function agentTimeRow(
  user: { id: string; name: string },
  input: {
    sessions: Interval[];
    shifts: Interval[];
    pauses: { reason: string | null; iv: Interval }[];
    talk?: Interval[];
    wrapUps?: Interval[];
  },
  from: number,
  to: number
): AgentTimeRow {
  const logged = mergeIntervals(input.sessions, from, to);
  const scheduled = mergeIntervals(input.shifts, from, to);
  const scheduledSecs = totalSecs(scheduled);
  const inShift = overlapSecs(logged, scheduled);
  const talk = mergeIntervals(input.talk ?? [], from, to);
  const wrap = mergeIntervals(input.wrapUps ?? [], from, to);
  const busy = mergeIntervals([...input.pauses.map((p) => p.iv), ...talk, ...wrap], from, to);
  const byReason = new Map<string | null, { secs: number; count: number }>();
  for (const p of input.pauses) {
    const secs = totalSecs(mergeIntervals([p.iv], from, to));
    if (secs === 0) continue;
    const r = byReason.get(p.reason) ?? { secs: 0, count: 0 };
    r.secs += secs;
    r.count++;
    byReason.set(p.reason, r);
  }
  return {
    userId: user.id,
    name: user.name,
    scheduledSecs,
    loggedSecs: totalSecs(logged),
    loggedInShiftSecs: inShift,
    adherencePct: scheduledSecs ? Math.round((inShift / scheduledSecs) * 1000) / 10 : null,
    pausedSecs: totalSecs(mergeIntervals(input.pauses.map((p) => p.iv), from, to)),
    pauses: [...byReason].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.secs - a.secs),
    talkSecs: totalSecs(talk),
    wrapUpSecs: totalSecs(wrap),
    availableSecs: Math.max(0, totalSecs(logged) - overlapSecs(logged, busy)),
  };
}

export type AgentState = "LOGGED_IN" | "LOGGED_OUT" | "PAUSED" | "IN_CALL" | "WRAP_UP";
export interface StateSegment { state: AgentState; from: number; to: number | null; detail: string | null }

/**
 * Linha do tempo dos estados de um agente no período: ligado/desligado (sessões
 * juntas e os buracos entre elas), pausas, conversas e pós-chamada. Intervalos
 * abertos chegam já fechados em `now`; o que ainda decorre sai com to = null.
 */
export function agentStateTimeline(
  input: {
    sessions: Interval[];
    pauses: { iv: Interval; reason: string | null }[];
    calls: { iv: Interval; number: string | null }[];
    wrapUps: { iv: Interval; number: string | null }[];
  },
  from: number,
  to: number,
  now: number
): StateSegment[] {
  const end = Math.min(to, now);
  const out: StateSegment[] = [];
  const push = (state: AgentState, [a, b]: Interval, detail: string | null) => {
    const lo = Math.max(a, from);
    const hi = Math.min(b, end);
    if (hi > lo) out.push({ state, from: lo, to: hi >= now ? null : hi, detail });
  };
  let cursor = from;
  for (const iv of mergeIntervals(input.sessions, from, end)) {
    push("LOGGED_OUT", [cursor, iv[0]], null);
    push("LOGGED_IN", iv, null);
    cursor = iv[1];
  }
  push("LOGGED_OUT", [cursor, end], null);
  for (const p of input.pauses) push("PAUSED", p.iv, p.reason);
  for (const c of input.calls) push("IN_CALL", c.iv, c.number);
  for (const w of input.wrapUps) push("WRAP_UP", w.iv, w.number);
  const rank: Record<AgentState, number> = { LOGGED_OUT: 0, LOGGED_IN: 0, PAUSED: 1, IN_CALL: 1, WRAP_UP: 2 };
  return out.sort((x, y) => x.from - y.from || rank[x.state] - rank[y.state]);
}

interface LegTimes { outcome: string | null; answeredAt: Date | null; endedAt: Date | null; typedAt: Date | null; wrapUpEndsAt: Date | null }

/** Conversa: de atender a desligar (ainda em curso → now). */
const talkInterval = (l: LegTimes, now: Date): Interval | null =>
  l.outcome === "ANSWERED" && l.answeredAt ? [l.answeredAt.getTime(), (l.endedAt ?? now).getTime()] : null;

/** Pós-chamada: mesma regra dos relatórios (wrapUpSecs); a decorrer → até now. */
function wrapUpInterval(l: LegTimes, now: Date): Interval | null {
  if (!l.endedAt) return null;
  const secs = wrapUpSecs(l, now);
  if (secs !== null) return secs > 0 ? [l.endedAt.getTime(), l.endedAt.getTime() + secs * 1000] : null;
  return typingStatus(l, now) === "PENDING" ? [l.endedAt.getTime(), now.getTime()] : null;
}

const legSelect = { extensionId: true, outcome: true, answeredAt: true, endedAt: true, typedAt: true, wrapUpEndsAt: true } as const;
/** Pernas atendidas que podem tocar o período (a pós-chamada pode passar do fim da chamada). */
const legWhere = (extensionIds: string[], from: Date, to: Date) => ({
  extensionId: { in: extensionIds },
  outcome: "ANSWERED" as const,
  answeredAt: { lte: to },
  OR: [{ endedAt: null }, { endedAt: { gte: new Date(from.getTime() - 86_400_000) } }],
});

// ─── BD ──────────────────────────────────────────────────────────────────────

export async function buildAgentTimeReport(tenantId: string, scope: UserScope, from: Date, to: Date, now = new Date()) {
  const end = Math.min(to.getTime(), now.getTime());
  const users = await prisma.tenantUser.findMany({
    where: { tenantId, ...(scope.kind !== "ALL" && { id: { in: scope.kind === "SELF" ? [scope.userId] : scope.userIds } }) },
    select: { id: true, name: true, extensionId: true },
    orderBy: { name: "asc" },
  });
  const ids = users.map((u) => u.id);
  const range = { lte: to };
  const extIds = users.map((u) => u.extensionId).filter((x): x is string => !!x);
  const [sessions, shifts, pauses, legs] = await Promise.all([
    prisma.agentSession.findMany({
      where: { tenantId, userId: { in: ids }, startedAt: range, OR: [{ endedAt: null }, { endedAt: { gte: from } }] },
      select: { userId: true, startedAt: true, endedAt: true },
    }),
    prisma.shift.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, weekday: true, startMin: true, endMin: true } }),
    prisma.agentPause.findMany({
      where: { tenantId, userId: { in: ids }, startedAt: range, OR: [{ endedAt: null }, { endedAt: { gte: from } }] },
      select: { userId: true, startedAt: true, endedAt: true, reason: { select: { label: true } } },
    }),
    prisma.callLeg.findMany({ where: { tenantId, ...legWhere(extIds, from, to) }, select: legSelect }),
  ]);
  const iv = (a: Date, b: Date | null): Interval => [a.getTime(), (b ?? now).getTime()];
  const nonNull = <T,>(x: T | null): x is T => x !== null;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    data: users.map((u) =>
      agentTimeRow(
        u,
        {
          sessions: sessions.filter((s) => s.userId === u.id).map((s) => iv(s.startedAt, s.endedAt)),
          shifts: shiftIntervals(shifts.filter((s) => s.userId === u.id), from, to),
          pauses: pauses.filter((p) => p.userId === u.id).map((p) => ({ reason: p.reason?.label ?? null, iv: iv(p.startedAt, p.endedAt) })),
          talk: legs.filter((l) => l.extensionId && l.extensionId === u.extensionId).map((l) => talkInterval(l, now)).filter(nonNull),
          wrapUps: legs.filter((l) => l.extensionId && l.extensionId === u.extensionId).map((l) => wrapUpInterval(l, now)).filter(nonNull),
        },
        from.getTime(),
        end
      )
    ),
  };
}

/** Linha do tempo dos estados de um utilizador (null = não existe neste tenant). */
export async function buildAgentStates(tenantId: string, userId: string, from: Date, to: Date, now = new Date()) {
  const user = await prisma.tenantUser.findFirst({ where: { id: userId, tenantId }, select: { id: true, name: true, extensionId: true } });
  if (!user) return null;
  const range = { startedAt: { lte: to }, OR: [{ endedAt: null }, { endedAt: { gte: from } }] };
  const [sessions, pauses, legs] = await Promise.all([
    prisma.agentSession.findMany({ where: { tenantId, userId, ...range }, select: { startedAt: true, endedAt: true } }),
    prisma.agentPause.findMany({ where: { tenantId, userId, ...range }, select: { startedAt: true, endedAt: true, reason: { select: { label: true } } } }),
    user.extensionId
      ? prisma.callLeg.findMany({ where: { tenantId, ...legWhere([user.extensionId], from, to) }, select: { ...legSelect, call: { select: { fromNumber: true } } } })
      : Promise.resolve([]),
  ]);
  const iv = (a: Date, b: Date | null): Interval => [a.getTime(), (b ?? now).getTime()];
  const withIv = <T,>(list: { iv: Interval | null; number: T }[]) => list.filter((x): x is { iv: Interval; number: T } => x.iv !== null);
  const timeline = agentStateTimeline(
    {
      sessions: sessions.map((s) => iv(s.startedAt, s.endedAt)),
      pauses: pauses.map((p) => ({ iv: iv(p.startedAt, p.endedAt), reason: p.reason?.label ?? null })),
      calls: withIv(legs.map((l) => ({ iv: talkInterval(l, now), number: l.call.fromNumber }))),
      wrapUps: withIv(legs.map((l) => ({ iv: wrapUpInterval(l, now), number: l.call.fromNumber }))),
    },
    from.getTime(),
    to.getTime(),
    now.getTime()
  );
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    user: { id: user.id, name: user.name },
    from: from.toISOString(),
    to: to.toISOString(),
    data: timeline.map((s) => ({ ...s, from: iso(s.from), to: s.to === null ? null : iso(s.to) })),
  };
}

/**
 * Pausa ou retoma uma extensão. Cada pausa fica registada com o motivo; mudar
 * de motivo sem retomar fecha a pausa anterior e abre outra.
 */
export async function setExtensionPause(tenantId: string, extensionId: string, paused: boolean, reasonId: string | null) {
  const ext = await prisma.extension.findFirst({ where: { id: extensionId, tenantId }, select: { id: true, users: { select: { id: true }, take: 1 } } });
  if (!ext) return null;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.agentPause.updateMany({ where: { extensionId, endedAt: null }, data: { endedAt: now } });
    await tx.extension.update({ where: { id: extensionId }, data: { pausedAt: paused ? now : null } });
    if (paused) {
      await tx.agentPause.create({ data: { tenantId, extensionId, userId: ext.users[0]?.id ?? null, reasonId, startedAt: now } });
    }
  });
  return { paused, since: paused ? now : null };
}

// ─── Sessões (abertas e fechadas pelo stream SSE do CRM) ─────────────────────

const SESSION_TOUCH_MS = 5 * 60_000;
// Ligações abertas por utilizador nesta instância: a sessão abre na 1ª e fecha na última.
const live = new Map<string, { count: number; sessionId: string; touchedAt: number }>();

/** Tem o CRM aberto agora (nesta instância da API). Usado pelo despacho dos callbacks da fila. */
export const isUserLive = (userId: string) => live.has(userId);

export async function sessionConnected(tenantId: string, userId: string): Promise<void> {
  const cur = live.get(userId);
  if (cur) {
    cur.count++;
    return;
  }
  // Reserva antes do await para dois separadores ao mesmo tempo não abrirem duas.
  const entry = { count: 1, sessionId: "", touchedAt: Date.now() };
  live.set(userId, entry);
  const s = await prisma.agentSession.create({ data: { tenantId, userId }, select: { id: true } });
  entry.sessionId = s.id;
}

/** Chamado no keepalive do SSE: marca que continua ligado (no máximo a cada 5 min). */
export async function sessionTouch(userId: string): Promise<void> {
  const cur = live.get(userId);
  if (!cur?.sessionId || Date.now() - cur.touchedAt < SESSION_TOUCH_MS) return;
  cur.touchedAt = Date.now();
  await prisma.agentSession.update({ where: { id: cur.sessionId }, data: { lastSeenAt: new Date() } });
}

export async function sessionDisconnected(userId: string): Promise<void> {
  const cur = live.get(userId);
  if (!cur) return;
  if (--cur.count > 0) return;
  live.delete(userId);
  if (cur.sessionId) {
    const now = new Date();
    await prisma.agentSession.update({ where: { id: cur.sessionId }, data: { endedAt: now, lastSeenAt: now } });
  }
}

/**
 * No arranque: sessões que ficaram abertas (a API caiu) fecham na última vez
 * que se viu o utilizador.
 * ponytail: com várias instâncias da API isto fecharia as das outras —
 * passar a filtrar por instância se houver mais do que uma.
 */
export async function closeStaleSessions(): Promise<number> {
  const open = await prisma.agentSession.findMany({ where: { endedAt: null }, select: { id: true, lastSeenAt: true } });
  for (const s of open) await prisma.agentSession.update({ where: { id: s.id }, data: { endedAt: s.lastSeenAt } });
  return open.length;
}
