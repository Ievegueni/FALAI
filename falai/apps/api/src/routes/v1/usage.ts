import type { FastifyInstance } from "fastify";
import { prisma, Prisma } from "@falai/db";

/**
 * Consumo e estado da conta, por API.
 *
 * No produto API_BYOM o cliente não tem dashboard nosso: é daqui que o CRM dele
 * tira o que mostrar. Inclui de propósito as violações de guardrail — ele tem
 * direito a saber quando as respostas do modelo dele estão a ser corrigidas,
 * em vez de descobrir quando o modelo é bloqueado.
 */

/** Início do dia, N dias atrás. */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function v1UsageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/usage", { preHandler: [fastify.verifyScope("wallet:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(parseInt(query.days ?? "30", 10) || 30, 1), 90);
    const since = daysAgo(days);

    const [calls, turns, guardrailTurns, sms, tenant] = await Promise.all([
      prisma.call.aggregate({
        where: { tenantId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { durationSecs: true, costCents: true },
      }),
      prisma.callTurn.count({
        where: { call: { tenantId, createdAt: { gte: since } } },
      }),
      prisma.callTurn.count({
        where: {
          call: { tenantId, createdAt: { gte: since } },
          // Turnos sinalizados = coluna preenchida. DbNull é o NULL da base de
          // dados; JsonNull seria o literal `null` guardado como JSON.
          guardrailFlags: { not: Prisma.DbNull },
        },
      }),
      prisma.smsMessage.count({ where: { tenantId, createdAt: { gte: since } } }),
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { balanceCents: true, status: true, maxConcurrent: true },
      }),
    ]);

    // Chamadas por estado — é o que dá para perceber se algo está partido.
    const byStatus = await prisma.call.groupBy({
      by: ["status"],
      where: { tenantId, createdAt: { gte: since } },
      _count: { _all: true },
    });

    return reply.send({
      period: { since: since.toISOString(), days },
      calls: {
        total: calls._count._all,
        durationSecs: calls._sum.durationSecs ?? 0,
        costCents: calls._sum.costCents ?? 0,
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      },
      turns: {
        total: turns,
        // Turnos em que a resposta do modelo foi corrigida ou recusada.
        guardrailFlagged: guardrailTurns,
      },
      sms: { total: sms },
      account: {
        balanceCents: tenant?.balanceCents ?? 0,
        status: tenant?.status ?? "UNKNOWN",
        maxConcurrent: tenant?.maxConcurrent ?? 1,
      },
    });
  });

  /**
   * Estado operacional: dá para o CRM dele mostrar um semáforo e para um
   * monitor externo alertar antes de o cliente final reparar.
   */
  fastify.get("/v1/status", { preHandler: [fastify.verifyScope("models:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;

    const [tenant, models, agents, trunk] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, balanceCents: true, creditLimitCents: true },
      }),
      prisma.tenantModel.findMany({
        where: { tenantId, deletedAt: null },
        select: {
          id: true, name: true, status: true, lastHealthAt: true,
          lastLatencyMs: true, lastError: true, violations: true,
        },
      }),
      prisma.agent.groupBy({
        by: ["status"],
        where: { tenantId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.trunk.findFirst({
        where: { tenantId, enabled: true },
        select: { name: true, type: true, enabled: true },
      }),
    ]);

    if (!tenant) return reply.status(404).send({ error: "Tenant not found" });

    const activeModel = models.find((m) => m.status === "ACTIVE") ?? null;
    const spendable = tenant.balanceCents + tenant.creditLimitCents;

    return reply.send({
      account: {
        status: tenant.status,
        balanceCents: tenant.balanceCents,
        // O que interessa a quem só quer saber "posso ligar?".
        canPlaceCalls: tenant.status !== "SUSPENDED" && tenant.status !== "CLOSED" && spendable > 0,
      },
      models: models.map((m) => ({
        ...m,
        lastHealthAt: m.lastHealthAt?.toISOString() ?? null,
      })),
      activeModel: activeModel?.id ?? null,
      agents: Object.fromEntries(agents.map((r) => [r.status, r._count._all])),
      trunk: trunk ? { name: trunk.name, type: trunk.type, enabled: trunk.enabled } : null,
    });
  });
}
