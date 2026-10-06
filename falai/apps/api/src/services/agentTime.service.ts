import { prisma } from "@falai/db";
import type { UserScope } from "./userScope.js";

/**
 * Tempo dos agentes (centro de atendimento, fase 5) — ver
 * docs/PLANO-CENTRO-ATENDIMENTO.md.
 *
 *   Escalado  = soma dos turnos (Shift) no período
 *   Ligado    = sessões no CRM (AgentSession), sobreposições juntas (vários separadores)
 *   Aderência = % do escalado em que esteve ligado
 *   Pausa     = pausas da extensão (AgentPause), por motivo
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
}

export function agentTimeRow(
  user: { id: string; name: string },
  input: {
    sessions: Interval[];
    shifts: Interval[];
    pauses: { reason: string | null; iv: Interval }[];
  },
  from: number,
  to: number
): AgentTimeRow {
  const logged = mergeIntervals(input.sessions, from, to);
  const scheduled = mergeIntervals(input.shifts, from, to);
  const scheduledSecs = totalSecs(scheduled);
  const inShift = overlapSecs(logged, scheduled);
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
  };
}

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
  const [sessions, shifts, pauses] = await Promise.all([
    prisma.agentSession.findMany({
      where: { tenantId, userId: { in: ids }, startedAt: range, OR: [{ endedAt: null }, { endedAt: { gte: from } }] },
      select: { userId: true, startedAt: true, endedAt: true },
    }),
    prisma.shift.findMany({ where: { tenantId, userId: { in: ids } }, select: { userId: true, weekday: true, startMin: true, endMin: true } }),
    prisma.agentPause.findMany({
      where: { tenantId, userId: { in: ids }, startedAt: range, OR: [{ endedAt: null }, { endedAt: { gte: from } }] },
      select: { userId: true, startedAt: true, endedAt: true, reason: { select: { label: true } } },
    }),
  ]);
  const iv = (a: Date, b: Date | null): Interval => [a.getTime(), (b ?? now).getTime()];
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
        },
        from.getTime(),
        end
      )
    ),
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
