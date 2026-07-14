import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";

export async function v1CampaignsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/campaigns", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const query = request.query as { limit?: string; offset?: string; status?: string };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);
    const where = { tenantId, ...(query.status && { status: query.status as never }) };

    const [campaigns, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        select: {
          id: true, name: true, status: true, agentId: true,
          totalContacts: true, completed: true, failedCount: true,
          scheduleJson: true, createdAt: true, updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.campaign.count({ where }),
    ]);

    return reply.send({ data: campaigns, total, limit, offset });
  });

  fastify.get("/v1/campaigns/:id", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: {
        id: true, tenantId: true, name: true, status: true, agentId: true,
        totalContacts: true, completed: true, failedCount: true,
        scheduleJson: true, retryPolicy: true, throttlePerMinute: true,
        summary: true, createdAt: true, updatedAt: true,
      },
    });

    if (!campaign || campaign.tenantId !== tenantId) return reply.status(404).send({ error: "Campaign not found" });
    return reply.send(campaign);
  });

  fastify.post("/v1/campaigns", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const body = request.body as {
      name: string;
      agentId: string;
      scheduleJson?: Record<string, unknown>;
      retryPolicy?: Record<string, unknown>;
      throttlePerMinute?: number;
    };

    if (!body.name || !body.agentId) return reply.status(400).send({ error: "name and agentId are required" });

    const agent = await prisma.agent.findUnique({
      where: { id: body.agentId, tenantId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    if (agent.status !== "ACTIVE") return reply.status(422).send({ error: "Agent must be ACTIVE" });

    const campaign = await prisma.campaign.create({
      data: {
        tenantId,
        agentId: body.agentId,
        name: body.name,
        ...(body.scheduleJson !== undefined && { scheduleJson: body.scheduleJson as Prisma.InputJsonValue }),
        ...(body.retryPolicy !== undefined && { retryPolicy: body.retryPolicy as Prisma.InputJsonValue }),
        ...(body.throttlePerMinute !== undefined && { throttlePerMinute: body.throttlePerMinute }),
      },
      select: { id: true, name: true, status: true, agentId: true, createdAt: true },
    });

    return reply.status(201).send(campaign);
  });
}
