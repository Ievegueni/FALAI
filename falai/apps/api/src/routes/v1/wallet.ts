import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";

export async function v1WalletRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/wallet", { preHandler: [fastify.verifyScope("wallet:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);

    const [tenant, transactions, total] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { balanceCents: true, creditLimitCents: true },
      }),
      prisma.walletTransaction.findMany({
        where: { tenantId },
        select: { id: true, type: true, amountCents: true, balanceAfterCents: true, note: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.walletTransaction.count({ where: { tenantId } }),
    ]);

    if (!tenant) return reply.status(404).send({ error: "Tenant not found" });

    return reply.send({
      balanceCents: tenant.balanceCents,
      creditLimitCents: tenant.creditLimitCents,
      availableCents: tenant.balanceCents + tenant.creditLimitCents,
      transactions: { data: transactions, total, limit, offset },
    });
  });
}
