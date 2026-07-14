import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";

export async function tenantWebhookEventsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/tenant/webhook-events", { preHandler: [fastify.verifyTenant] }, async (request, reply) => {
    const tenantId = request.tenantUser!.tenantId;
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);

    const where = { tenantId, source: "webhooks_out", severity: "ERROR" };

    const [events, total] = await Promise.all([
      prisma.systemEvent.findMany({
        where,
        select: { id: true, message: true, payload: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.systemEvent.count({ where }),
    ]);

    return reply.send({ data: events, total, limit, offset });
  });
}
