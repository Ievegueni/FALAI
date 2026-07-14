import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";

export async function adminAuditRoutes(fastify: FastifyInstance): Promise<void> {
  const preHandler = [fastify.authenticate];

  fastify.get("/admin/audit", { preHandler }, async (request, reply) => {
    const query = request.query as {
      actorType?: string;
      actorId?: string;
      tenantId?: string;
      action?: string;
      targetType?: string;
      targetId?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit ?? "50", 10), 200);
    const offset = parseInt(query.offset ?? "0", 10);

    const where = {
      ...(query.actorType && { actorType: query.actorType }),
      ...(query.actorId && { actorId: query.actorId }),
      ...(query.tenantId && { tenantId: query.tenantId }),
      ...(query.action && { action: { contains: query.action } }),
      ...(query.targetType && { targetType: query.targetType }),
      ...(query.targetId && { targetId: query.targetId }),
      ...((query.from ?? query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };

    const [entries, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return reply.send({ data: entries, total, limit, offset });
  });

  // Admin system events (errors, warnings from all sources)
  fastify.get("/admin/events", { preHandler }, async (request, reply) => {
    const query = request.query as {
      severity?: string;
      source?: string;
      tenantId?: string;
      from?: string;
      to?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(parseInt(query.limit ?? "50", 10), 200);
    const offset = parseInt(query.offset ?? "0", 10);

    const where = {
      ...(query.severity && { severity: query.severity }),
      ...(query.source && { source: query.source }),
      ...(query.tenantId && { tenantId: query.tenantId }),
      ...((query.from ?? query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };

    const [events, total] = await Promise.all([
      prisma.systemEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.systemEvent.count({ where }),
    ]);

    return reply.send({ data: events, total, limit, offset });
  });
}
