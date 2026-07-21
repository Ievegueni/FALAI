import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { ensureCdrSynced, mapPbxCall, pbxCallStatus, PBX_CALL_SELECT, activeInboundCalls } from "../../services/pbxCdr.service.js";

export const tenantDashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/dashboard — key metrics for the CRM home screen
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;

    // Statuses that count as "answered" (the call actually connected)
    const ANSWERED: import("@falai/db").CallStatus[] = ["COMPLETED", "ESCALATED"];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    // ── Tenants CRM (BYO-PBX): métricas a partir do CDR do PBX do cliente ──────
    const { isCrmPbx } = await ensureCdrSynced(fastify, tenantId);
    if (isCrmPbx) {
      const [tenant, activeAgents, activeCampaigns, monthRows, recentRows, liveInbound, chartRows] = await Promise.all([
        prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { balanceCents: true } }),
        prisma.agent.count({ where: { tenantId, status: "ACTIVE", deletedAt: null } }),
        prisma.campaign.count({ where: { tenantId, status: "RUNNING" } }),
        prisma.pbxCall.findMany({
          where: { tenantId, startedAt: { gte: monthStart } },
          select: { disposition: true, talkSecs: true, durationSecs: true, startedAt: true },
        }),
        prisma.pbxCall.findMany({
          where: { tenantId },
          orderBy: { startedAt: "desc" },
          take: 8,
          select: PBX_CALL_SELECT,
        }),
        activeInboundCalls(tenantId),
        prisma.pbxCall.findMany({
          where: { tenantId, startedAt: { gte: sevenDaysAgo } },
          select: { disposition: true, startedAt: true },
        }),
      ]);

      const callsToday = monthRows.filter((c) => c.startedAt >= today).length;
      const callsThisMonth = monthRows.length;
      const answeredMonth = monthRows.filter((c) => pbxCallStatus(c.disposition) === "COMPLETED");
      const avgDuration =
        answeredMonth.length > 0
          ? answeredMonth.reduce((s, c) => s + (c.talkSecs || c.durationSecs), 0) / answeredMonth.length
          : 0;

      const dailyBuckets = buildBuckets(sevenDaysAgo);
      for (const c of chartRows) {
        const bucket = dailyBuckets[c.startedAt.toISOString().slice(0, 10)];
        if (bucket) {
          bucket.total++;
          if (pbxCallStatus(c.disposition) === "COMPLETED") bucket.answered++;
        }
      }

      return {
        balanceCents: tenant.balanceCents,
        callsToday,
        callsThisMonth,
        answerRatePct: callsThisMonth > 0 ? (answeredMonth.length / callsThisMonth) * 100 : 0,
        avgDurationSecs: Math.round(avgDuration),
        avgCostCents: 0,
        activeAgents,
        activeCampaigns,
        recentCalls: [...liveInbound.map(mapLiveInbound), ...recentRows.map(mapPbxCall)].slice(0, 8),
        chartData: Object.entries(dailyBuckets).map(([date, v]) => ({ date, total: v.total, answered: v.answered })),
      };
    }

    // ── Tenants operador (VOICE_AI): métricas da tabela Call (IA) ──────────────
    const [tenant, callsToday, callsThisMonth, answeredThisMonth, activeAgents, activeCampaigns, monthAgg, recentRows] =
      await Promise.all([
        prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { balanceCents: true } }),
        prisma.call.count({ where: { tenantId, createdAt: { gte: today } } }),
        prisma.call.count({ where: { tenantId, createdAt: { gte: monthStart } } }),
        prisma.call.count({ where: { tenantId, createdAt: { gte: monthStart }, status: { in: ANSWERED } } }),
        prisma.agent.count({ where: { tenantId, status: "ACTIVE", deletedAt: null } }),
        prisma.campaign.count({ where: { tenantId, status: "RUNNING" } }),
        prisma.call.aggregate({
          where: { tenantId, createdAt: { gte: monthStart }, status: { in: ANSWERED } },
          _avg: { durationSecs: true, costCents: true },
        }),
        prisma.call.findMany({
          where: { tenantId },
          orderBy: { createdAt: "desc" },
          take: 8,
          select: {
            id: true, toNumber: true, fromNumber: true, kind: true, status: true, outcome: true,
            durationSecs: true, costCents: true, startedAt: true, endedAt: true, createdAt: true,
            agent: { select: { name: true } },
            contact: { select: { name: true } },
          },
        }),
      ]);

    const chartCalls = await prisma.call.findMany({
      where: { tenantId, createdAt: { gte: sevenDaysAgo } },
      select: { createdAt: true, status: true },
    });

    const dailyBuckets = buildBuckets(sevenDaysAgo);
    for (const call of chartCalls) {
      const bucket = dailyBuckets[call.createdAt.toISOString().slice(0, 10)];
      if (bucket) {
        bucket.total++;
        if (ANSWERED.includes(call.status)) bucket.answered++;
      }
    }

    return {
      balanceCents: tenant.balanceCents,
      callsToday,
      callsThisMonth,
      answerRatePct: callsThisMonth > 0 ? (answeredThisMonth / callsThisMonth) * 100 : 0,
      avgDurationSecs: Math.round(monthAgg._avg.durationSecs ?? 0),
      avgCostCents: Math.round(monthAgg._avg.costCents ?? 0),
      activeAgents,
      activeCampaigns,
      recentCalls: recentRows.map((c) => {
        const direction = c.kind === "INBOUND" ? "inbound" : "outbound";
        return {
          id: c.id,
          to: c.toNumber,
          from: c.fromNumber ?? null,
          party: direction === "inbound" ? c.fromNumber ?? c.toNumber : c.toNumber,
          direction,
          kind: c.kind,
          status: c.status,
          outcome: c.outcome,
          durationSecs: c.durationSecs,
          costCents: c.costCents,
          startedAt: c.startedAt,
          endedAt: c.endedAt,
          createdAt: c.createdAt,
          agent: c.agent,
          contact: c.contact,
        };
      }),
      chartData: Object.entries(dailyBuckets).map(([date, v]) => ({ date, total: v.total, answered: v.answered })),
    };
  });
};

// Chamada de entrada "ao vivo" (ainda sem CDR) → shape das chamadas recentes do dashboard
type LiveInboundRow = {
  id: string;
  toNumber: string;
  fromNumber: string | null;
  status: string;
  outcome: string | null;
  durationSecs: number;
  costCents: number;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  agent: { name: string } | null;
  contact: { name: string | null } | null;
};

function mapLiveInbound(c: LiveInboundRow) {
  return {
    id: c.id,
    to: c.toNumber,
    from: c.fromNumber,
    party: c.fromNumber ?? c.toNumber,
    direction: "inbound" as const,
    kind: "INBOUND" as const,
    status: c.status,
    outcome: c.outcome,
    durationSecs: c.durationSecs,
    costCents: c.costCents,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    createdAt: c.createdAt,
    agent: c.agent ?? { name: "" },
    contact: c.contact ? { name: c.contact.name ?? "" } : null,
  };
}

function buildBuckets(from: Date): Record<string, { total: number; answered: number }> {
  const buckets: Record<string, { total: number; answered: number }> = {};
  for (let d = 0; d < 7; d++) {
    const day = new Date(from);
    day.setDate(day.getDate() + d);
    buckets[day.toISOString().slice(0, 10)] = { total: 0, answered: 0 };
  }
  return buckets;
}
