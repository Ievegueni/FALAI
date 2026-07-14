import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";

export async function v1AgentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/agents", { preHandler: [fastify.verifyScope("agents:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;

    const agents = await prisma.agent.findMany({
      where: { tenantId, deletedAt: null },
      select: {
        id: true, name: true, description: true, status: true, language: true,
        maxCallSeconds: true, maxTurnSeconds: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return reply.send({ data: agents });
  });

  fastify.get("/v1/agents/:id", { preHandler: [fastify.verifyScope("agents:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const agent = await prisma.agent.findUnique({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true, name: true, description: true, status: true, language: true,
        ttsVoiceId: true, sttModel: true, maxCallSeconds: true, maxTurnSeconds: true,
        escalationNumber: true, variablesSchema: true,
        createdAt: true, updatedAt: true,
      },
    });

    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    return reply.send(agent);
  });
}
