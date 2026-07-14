import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";

export const adminDashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  fastify.get("/dashboard/metrics", { preHandler }, async (request) => {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      tenantsActive,
      tenantsTotal,
      callsTodayRaw,
      pbxCallsToday,
      invoicesPaidToday,
      agentsPendingReview,
      systemSettings,
      liveCalls,
    ] = await Promise.all([
      prisma.tenant.count({ where: { status: "ACTIVE", deletedAt: null } }),
      prisma.tenant.count({ where: { deletedAt: null } }),
      prisma.call.findMany({
        where: { createdAt: { gte: startOfDay } },
        select: { status: true, durationSecs: true, costCents: true, providerCostCents: true },
      }),
      // Chamadas dos tenants CRM (BYO-PBX), vindas do CDR
      prisma.pbxCall.findMany({
        where: { startedAt: { gte: startOfDay } },
        select: { talkSecs: true, durationSecs: true, disposition: true },
      }),
      // Receita de subscrições cobradas hoje
      prisma.invoice.findMany({
        where: { status: "PAID", paidAt: { gte: startOfDay } },
        select: { amountCents: true },
      }),
      prisma.agent.count({ where: { status: "PENDING_REVIEW", deletedAt: null } }),
      prisma.systemSetting.findMany({ where: { key: { in: ["MAX_CONCURRENT_CALLS"] } } }),
      prisma.call.findMany({
        where: { status: { in: ["IN_PROGRESS", "DIALING", "RINGING"] } },
        include: {
          tenant: { select: { name: true } },
          agent: { select: { name: true } },
        },
        orderBy: { startedAt: "desc" },
        take: 10,
      }),
    ]);

    const completed = callsTodayRaw.filter((c) => c.status === "COMPLETED");
    const pbxAnswered = pbxCallsToday.filter((c) => c.disposition.toUpperCase() === "ANSWERED");
    const callsToday = callsTodayRaw.length + pbxCallsToday.length;
    const minutesToday = Math.round(
      (completed.reduce((s, c) => s + c.durationSecs, 0) +
        pbxAnswered.reduce((s, c) => s + (c.talkSecs || c.durationSecs), 0)) /
        60
    );
    const perCallRevenue = completed.reduce((s, c) => s + c.costCents, 0);
    const subscriptionRevenue = invoicesPaidToday.reduce((s, i) => s + i.amountCents, 0);
    const revenueToday = perCallRevenue + subscriptionRevenue;
    const marginToday =
      completed.reduce((s, c) => s + (c.costCents - c.providerCostCents), 0) + subscriptionRevenue;

    const maxConcurrent = parseInt(
      systemSettings.find((s) => s.key === "MAX_CONCURRENT_CALLS")?.value ?? "50"
    );
    const concurrentNow = fastify.callEngine?.activeCallCount ?? liveCalls.length;

    // Gráfico — chamadas por hora nas últimas 24h (Call de IA + PbxCall do CDR)
    const [callsLast24h, pbxLast24h] = await Promise.all([
      prisma.call.findMany({
        where: { createdAt: { gte: last24h } },
        select: { createdAt: true, costCents: true, status: true },
      }),
      prisma.pbxCall.findMany({
        where: { startedAt: { gte: last24h } },
        select: { startedAt: true },
      }),
    ]);

    const buckets: Record<string, { calls: number; revenue: number }> = {};
    for (let h = 23; h >= 0; h--) {
      const d = new Date(now.getTime() - h * 60 * 60 * 1000);
      const key = `${d.getHours().toString().padStart(2, "0")}h`;
      buckets[key] = { calls: 0, revenue: 0 };
    }
    for (const c of callsLast24h) {
      const key = `${c.createdAt.getHours().toString().padStart(2, "0")}h`;
      if (buckets[key]) {
        buckets[key]!.calls++;
        if (c.status === "COMPLETED") buckets[key]!.revenue += c.costCents;
      }
    }
    for (const c of pbxLast24h) {
      const key = `${c.startedAt.getHours().toString().padStart(2, "0")}h`;
      if (buckets[key]) buckets[key]!.calls++;
    }
    const chartData = Object.entries(buckets).map(([date, v]) => ({ date, ...v }));

    return {
      tenantsActive,
      tenantsTotal,
      callsToday,
      minutesToday,
      revenueToday,
      marginToday,
      agentsPendingReview,
      concurrentNow,
      concurrentCapacity: maxConcurrent,
      liveCalls: liveCalls.map((c) => ({
        id: c.id,
        tenantName: c.tenant.name,
        agentName: c.agent.name,
        to: c.toNumber,
        status: c.status,
        durationSecs: c.durationSecs,
        startedAt: c.startedAt?.toISOString() ?? c.createdAt.toISOString(),
      })),
      chartData,
    };
  });
};
