import type { FastifyInstance } from "fastify";
import { prisma, Prisma, type AlertType } from "@falai/db";
import { extensionEndpointId, extensionWebEndpointId } from "@falai/providers";
import { abandonedIds, callKpis, type CallKpis } from "./attendanceReport.service.js";
import { parseTargets, slaRuleOf, type ServiceTargets } from "./serviceTargets.js";
import { activeInboundCalls } from "./inboundCallRouter.service.js";
import { emitWebhookAsync } from "./webhookEmitter.service.js";
import { tenantFeatures } from "./features.js";
import { loadConversations, textSla, type TextSla } from "./consolidated.service.js";
import { ticketSlaStatus } from "./tickets.service.js";

/**
 * Alertas operacionais e metas (centro de atendimento, fase 4) — ver
 * docs/PLANO-CENTRO-ATENDIMENTO.md.
 *
 * A cada TICK_MS a API avalia cada cliente com metas definidas:
 *   ao vivo  — chamada em espera há muito (LONG_WAIT), em curso há muito
 *              (LONG_HANDLE), grupo sem agentes disponíveis (NO_AGENTS);
 *   do dia   — SLA abaixo da meta, abandono ou TMA acima do limite (só com
 *              MIN_DAILY_SAMPLE chamadas terminadas, para não alarmar à 1ª);
 *              SLA dos canais de texto abaixo da meta (TEXT_SLA_BELOW);
 *   tickets  — em aberto a menos de ticketWarnMins do prazo (TICKET_DUE_SOON)
 *              ou com o prazo passado (TICKET_OVERDUE); ref = ticket.
 * Um alerta abre quando o limite é passado e fecha sozinho quando deixa de o
 * estar. Corre na API e não no worker porque o estado ao vivo (quem está
 * online, quem está em chamada) vive aqui.
 */

const TICK_MS = 15_000;
const DAILY_EVERY_MS = 60_000;
const MIN_DAILY_SAMPLE = 10;

export { targetsSchema, parseTargets, type ServiceTargets } from "./serviceTargets.js";

export interface Breach {
  type: AlertType;
  ref: string;
  groupId: string | null;
  value: number;
  threshold: number;
}

export interface LiveSnapshot {
  now: Date;
  waiting: { id: string; groupId: string | null; queuedAt: Date }[];
  inCall: { id: string; groupId: string | null; answeredAt: Date }[];
  /** Só os grupos com agentes. `waiting` = chamadas à espera nesse grupo. */
  groups: { id: string; online: number; available: number; waiting: number }[];
}

const secsSince = (from: Date, now: Date) => Math.round((now.getTime() - from.getTime()) / 1000);

/** Limites ao vivo passados neste momento. Pura. */
export function liveBreaches(s: LiveSnapshot, t: ServiceTargets): Breach[] {
  const out: Breach[] = [];
  if (t.maxWaitSecs !== null) {
    for (const c of s.waiting) {
      const v = secsSince(c.queuedAt, s.now);
      if (v > t.maxWaitSecs) out.push({ type: "LONG_WAIT", ref: c.id, groupId: c.groupId, value: v, threshold: t.maxWaitSecs });
    }
  }
  if (t.maxHandleSecs !== null) {
    for (const c of s.inCall) {
      const v = secsSince(c.answeredAt, s.now);
      if (v > t.maxHandleSecs) out.push({ type: "LONG_HANDLE", ref: c.id, groupId: c.groupId, value: v, threshold: t.maxHandleSecs });
    }
  }
  if (t.minAvailableAgents !== null) {
    for (const g of s.groups) {
      // Fora de horas (ninguém ligado e ninguém à espera) não é alerta.
      if (g.available < t.minAvailableAgents && (g.online > 0 || g.waiting > 0)) {
        out.push({ type: "NO_AGENTS", ref: g.id, groupId: g.id, value: g.available, threshold: t.minAvailableAgents });
      }
    }
  }
  return out;
}

export type DailyKpis = Pick<CallKpis, "answered" | "missed" | "abandoned" | "shortAbandoned" | "abandonRate" | "slaPct" | "tmaSecs">;

/**
 * Desvios do dia face às metas. Pura. `day` = AAAA-MM-DD (é a ref do alerta).
 * `byGroup` = KPIs do dia dos grupos com meta de SLA própria: o alerta desses
 * tem a ref `dia#grupo` (abre e fecha à parte do geral).
 */
export function dailyBreaches(k: DailyKpis, day: string, t: ServiceTargets, byGroup: Record<string, DailyKpis> = {}): Breach[] {
  const out: Breach[] = [];
  for (const [gid, g] of Object.entries(byGroup)) {
    const target = t.groups[gid]?.slaTargetPct ?? null;
    if (target === null || g.answered + g.missed - g.shortAbandoned < MIN_DAILY_SAMPLE) continue;
    if (g.slaPct !== null && g.slaPct < target) out.push({ type: "SLA_BELOW", ref: `${day}#${gid}`, groupId: gid, value: g.slaPct, threshold: target });
  }
  const finished = k.answered + k.missed - k.shortAbandoned;
  if (finished < MIN_DAILY_SAMPLE) return out;
  const abandonPct = k.abandonRate ?? 0;
  if (t.slaTargetPct !== null && k.slaPct !== null && k.slaPct < t.slaTargetPct) {
    out.push({ type: "SLA_BELOW", ref: day, groupId: null, value: k.slaPct, threshold: t.slaTargetPct });
  }
  if (t.maxAbandonPct !== null && abandonPct > t.maxAbandonPct) {
    out.push({ type: "ABANDON_ABOVE", ref: day, groupId: null, value: abandonPct, threshold: t.maxAbandonPct });
  }
  if (t.maxTmaSecs !== null && k.tmaSecs !== null && k.tmaSecs > t.maxTmaSecs) {
    out.push({ type: "TMA_ABOVE", ref: day, groupId: null, value: k.tmaSecs, threshold: t.maxTmaSecs });
  }
  return out;
}

/** SLA de texto do dia abaixo da meta (com a mesma amostra mínima). Pura. */
export function textBreaches(k: TextSla, day: string, t: ServiceTargets): Breach[] {
  if (t.textSlaTargetPct === null || k.slaPct === null || k.met + k.missed < MIN_DAILY_SAMPLE) return [];
  return k.slaPct < t.textSlaTargetPct ? [{ type: "TEXT_SLA_BELOW", ref: day, groupId: null, value: k.slaPct, threshold: t.textSlaTargetPct }] : [];
}

/** Ticket ainda em aberto, com prazo. */
export interface OpenTicket { id: string; groupId: string | null; dueAt: Date }

/** Tickets perto do prazo (valor = segundos que faltam) ou fora dele (segundos de atraso). Pura. */
export function ticketBreaches(tickets: OpenTicket[], t: ServiceTargets, now: Date): Breach[] {
  const out: Breach[] = [];
  for (const tk of tickets) {
    const st = ticketSlaStatus({ dueAt: tk.dueAt, resolvedAt: null }, now, t.ticketWarnMins);
    const left = Math.round((tk.dueAt.getTime() - now.getTime()) / 1000);
    if (st === "BREACHED") out.push({ type: "TICKET_OVERDUE", ref: tk.id, groupId: tk.groupId, value: -left, threshold: 0 });
    else if (st === "AT_RISK") out.push({ type: "TICKET_DUE_SOON", ref: tk.id, groupId: tk.groupId, value: left, threshold: t.ticketWarnMins * 60 });
  }
  return out;
}

/** O cliente quer alertas dos prazos dos tickets (tem política ou meta). */
export const wantsTicketAlerts = (t: ServiceTargets) => Object.values(t.ticketHours).some((h) => h !== null) || t.ticketSlaTargetPct !== null;

const key = (a: { type: string; ref: string }) => `${a.type}:${a.ref}`;
const DAILY: AlertType[] = ["SLA_BELOW", "ABANDON_ABOVE", "TMA_ABOVE", "TEXT_SLA_BELOW"];
const TICKETS: AlertType[] = ["TICKET_DUE_SOON", "TICKET_OVERDUE"];
// ponytail: no máximo isto de tickets por volta (os mais atrasados primeiro); paginar se um cliente acumular mais.
const MAX_TICKET_ALERTS = 200;

/**
 * O que abrir e o que fechar. `evaluated` = tipos avaliados nesta volta: um
 * alerta aberto de um tipo que não foi avaliado (ex.: os do dia, que só se
 * calculam a cada minuto) não fecha por falta de dados.
 */
export function diffAlerts(
  open: { id: string; type: AlertType; ref: string }[],
  breaches: Breach[],
  evaluated: Set<AlertType>
): { toOpen: Breach[]; toClose: string[] } {
  const openKeys = new Set(open.map(key));
  const breachKeys = new Set(breaches.map(key));
  return {
    toOpen: breaches.filter((b) => !openKeys.has(key(b))),
    toClose: open.filter((a) => evaluated.has(a.type) && !breachKeys.has(key(a))).map((a) => a.id),
  };
}

// ─── BD e motor ───────────────────────────────────────────────────────────────

export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

async function liveSnapshot(fastify: FastifyInstance, tenantId: string, t: ServiceTargets, now: Date): Promise<LiveSnapshot> {
  const [waiting, inCall] = await Promise.all([
    t.maxWaitSecs !== null || t.minAvailableAgents !== null
      ? prisma.call.findMany({
          // limite de 2 h: uma linha que ficou pendurada não alarma para sempre
          where: { tenantId, kind: "INBOUND", queuedAt: { not: null, gte: new Date(now.getTime() - 2 * 3600_000) }, answeredAt: null, endedAt: null },
          select: { id: true, groupId: true, queuedAt: true },
        })
      : [],
    t.maxHandleSecs !== null
      ? prisma.call.findMany({
          where: { tenantId, kind: "INBOUND", answeredAt: { not: null, gte: new Date(now.getTime() - 12 * 3600_000) }, endedAt: null },
          select: { id: true, groupId: true, answeredAt: true },
        })
      : [],
  ]);

  const groups: LiveSnapshot["groups"] = [];
  if (t.minAvailableAgents !== null) {
    const rows = await prisma.extensionGroup.findMany({
      where: { tenantId },
      select: { id: true, members: { select: { extension: { select: { id: true, sipAuthUser: true, pausedAt: true, isActive: true } } } } },
    });
    const busy = new Set(activeInboundCalls(tenantId).map((c) => c.agentExtensionId));
    const online = new Map<string, boolean>();
    const isOnline = async (sip: string) => {
      if (!online.has(sip)) {
        const states = await Promise.all(
          [extensionEndpointId(sip), extensionWebEndpointId(sip)].map((e) => fastify.asterisk.endpointState(e).catch(() => "unknown"))
        );
        online.set(sip, states.includes("online"));
      }
      return online.get(sip)!;
    };
    for (const g of rows) {
      const exts = g.members.map((m) => m.extension).filter((e) => e.isActive);
      if (exts.length === 0) continue;
      let on = 0;
      let available = 0;
      for (const e of exts) {
        if (!(await isOnline(e.sipAuthUser))) continue;
        on++;
        if (!e.pausedAt && !busy.has(e.id)) available++;
      }
      groups.push({ id: g.id, online: on, available, waiting: waiting.filter((c) => c.groupId === g.id).length });
    }
  }
  return {
    now,
    waiting: waiting.map((c) => ({ ...c, queuedAt: c.queuedAt! })),
    inCall: inCall.map((c) => ({ ...c, answeredAt: c.answeredAt! })),
    groups,
  };
}

async function dailyKpis(tenantId: string, t: ServiceTargets, now: Date): Promise<{ all: DailyKpis; byGroup: Record<string, DailyKpis> }> {
  const from = startOfDay(now);
  const [calls, legs] = await Promise.all([
    prisma.call.findMany({
      where: { tenantId, kind: "INBOUND", queuedAt: { gte: from } },
      select: { id: true, queuedAt: true, answeredAt: true, endedAt: true, groupId: true },
    }),
    prisma.callLeg.findMany({ where: { tenantId, ringStartedAt: { gte: from }, outcome: "CANCELLED" }, select: { callId: true, outcome: true } }),
  ]);
  const abandoned = abandonedIds(legs);
  const rule = slaRuleOf(t);
  const byGroup: Record<string, DailyKpis> = {};
  for (const [gid, g] of Object.entries(t.groups)) {
    if (g.slaTargetPct !== null) byGroup[gid] = callKpis(calls.filter((c) => c.groupId === gid), abandoned, rule);
  }
  return { all: callKpis(calls, abandoned, rule), byGroup };
}

/** Valor final de um alerta que fecha (para o relatório de desvios). */
async function endValueOf(a: { type: AlertType; ref: string }, now: Date, live: LiveSnapshot, daily: Awaited<ReturnType<typeof dailyKpis>> | null, text: TextSla | null): Promise<number | null> {
  if (a.type === "TEXT_SLA_BELOW") return text?.slaPct ?? null;
  if (TICKETS.includes(a.type)) {
    const tk = await prisma.ticket.findUnique({ where: { id: a.ref }, select: { dueAt: true, resolvedAt: true } });
    // Fecha com o atraso final (segundos; negativo = resolvido/fechado a tempo).
    return tk?.dueAt ? Math.round(((tk.resolvedAt ?? now).getTime() - tk.dueAt.getTime()) / 1000) : null;
  }
  if (a.type === "LONG_WAIT" || a.type === "LONG_HANDLE") {
    const c = await prisma.call.findUnique({ where: { id: a.ref }, select: { queuedAt: true, answeredAt: true, endedAt: true } });
    if (!c) return null;
    const [from, to] = a.type === "LONG_WAIT" ? [c.queuedAt, c.answeredAt ?? c.endedAt ?? now] : [c.answeredAt, c.endedAt ?? now];
    return from ? secsSince(from, to) : null;
  }
  if (a.type === "NO_AGENTS") return live.groups.find((g) => g.id === a.ref)?.available ?? null;
  if (!daily) return null;
  const gid = a.ref.split("#")[1];
  if (a.type === "SLA_BELOW") return (gid ? daily.byGroup[gid]?.slaPct : daily.all.slaPct) ?? null;
  if (a.type === "TMA_ABOVE") return daily.all.tmaSecs;
  return daily.all.abandonRate;
}

const lastDaily = new Map<string, number>();

/** Funcionalidades que decidem o que se avalia: voz (webphone), texto (inbox), tickets. */
export interface AlertScope { voice: boolean; text: boolean; tickets: boolean }

export async function evaluateTenant(fastify: FastifyInstance, tenantId: string, t: ServiceTargets, now = new Date(), scope: AlertScope = { voice: true, text: true, tickets: true }) {
  const live: LiveSnapshot = scope.voice ? await liveSnapshot(fastify, tenantId, t, now) : { now, waiting: [], inCall: [], groups: [] };
  const evaluated = new Set<AlertType>(scope.voice ? ["LONG_WAIT", "LONG_HANDLE", "NO_AGENTS"] : []);
  const breaches = liveBreaches(live, t);

  if (scope.tickets && wantsTicketAlerts(t)) {
    const open = await prisma.ticket.findMany({
      where: { tenantId, status: { in: ["OPEN", "PENDING", "ON_HOLD"] }, dueAt: { not: null, lte: new Date(now.getTime() + t.ticketWarnMins * 60_000) } },
      select: { id: true, groupId: true, dueAt: true },
      orderBy: { dueAt: "asc" },
      take: MAX_TICKET_ALERTS,
    });
    breaches.push(...ticketBreaches(open.map((x) => ({ ...x, dueAt: x.dueAt! })), t, now));
    TICKETS.forEach((d) => evaluated.add(d));
  }

  let daily: Awaited<ReturnType<typeof dailyKpis>> | null = null;
  let text: TextSla | null = null;
  const wantsDaily =
    scope.voice && (t.slaTargetPct !== null || t.maxAbandonPct !== null || t.maxTmaSecs !== null || Object.values(t.groups).some((g) => g.slaTargetPct !== null));
  const wantsText = scope.text && t.textSlaTargetPct !== null;
  if ((wantsDaily || wantsText) && now.getTime() - (lastDaily.get(tenantId) ?? 0) >= DAILY_EVERY_MS) {
    lastDaily.set(tenantId, now.getTime());
    if (wantsDaily) {
      daily = await dailyKpis(tenantId, t, now);
      breaches.push(...dailyBreaches(daily.all, localDay(now), t, daily.byGroup));
    }
    if (wantsText) {
      text = textSla(await loadConversations(tenantId, { gte: startOfDay(now), lte: now }), t.textSlaSecs, now);
      breaches.push(...textBreaches(text, localDay(now), t));
    }
    // Um tipo sem meta também se avalia: assim o alerta que ficou aberto fecha.
    DAILY.forEach((d) => evaluated.add(d));
  }

  const open = await prisma.alert.findMany({ where: { tenantId, endedAt: null }, select: { id: true, type: true, ref: true, groupId: true } });
  // Um alerta do dia de ontem fecha sempre (a ref é o dia).
  const today = localDay(now);
  const stale = open.filter((a) => DAILY.includes(a.type) && a.ref.split("#")[0] !== today).map((a) => a.id);
  const { toOpen, toClose } = diffAlerts(open, breaches, evaluated);

  for (const b of toOpen) {
    try {
      const alert = await prisma.alert.create({
        data: { tenantId, type: b.type, ref: b.ref, groupId: b.groupId, value: b.value, threshold: b.threshold, openKey: `${tenantId}:${b.type}:${b.ref}` },
      });
      fastify.incomingCalls.broadcast(tenantId, "alert.opened", alert);
      emitWebhookAsync({ tenantId, event: "alert.opened", payload: { alertId: alert.id, type: alert.type, ref: alert.ref, groupId: alert.groupId, value: alert.value, threshold: alert.threshold } });
    } catch (err) {
      // Outra instância da API abriu-o primeiro.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  }
  for (const id of new Set([...toClose, ...stale])) {
    const a = open.find((x) => x.id === id)!;
    const endValue = await endValueOf(a, now, live, daily, text);
    const { count } = await prisma.alert.updateMany({ where: { id, endedAt: null }, data: { endedAt: now, endValue, openKey: null } });
    if (count) {
      fastify.incomingCalls.broadcast(tenantId, "alert.closed", { id, type: a.type, groupId: a.groupId });
      emitWebhookAsync({ tenantId, event: "alert.closed", payload: { alertId: id, type: a.type, ref: a.ref, groupId: a.groupId, endValue } });
    }
  }
}

/** Avaliação periódica de todos os clientes com metas definidas. */
export function startAlertEvaluator(fastify: FastifyInstance): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const tenants = await prisma.tenant.findMany({
        where: { serviceTargets: { not: Prisma.AnyNull }, deletedAt: null, status: { in: ["ACTIVE", "TRIAL"] } },
        select: { id: true, serviceTargets: true },
      });
      for (const tn of tenants) {
        const f = await tenantFeatures(tn.id);
        const scope = { voice: f.webphone, text: f.inbox, tickets: f.tickets };
        if (!scope.voice && !scope.text && !scope.tickets) continue;
        await evaluateTenant(fastify, tn.id, parseTargets(tn.serviceTargets), new Date(), scope).catch((err) =>
          fastify.log.warn({ err, tenantId: tn.id }, "alerts.evaluate_error")
        );
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
