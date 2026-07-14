import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";

const rejectSchema = z.object({
  reason: z.string().min(10).max(500),
});

const simulateSchema = z.object({
  history: z
    .array(z.object({ role: z.enum(["human", "agent", "system"]), text: z.string() }))
    .optional()
    .default([]),
  userText: z.string().min(1).max(1000),
  variables: z.record(z.unknown()).optional(),
});

export const adminAgentsModerationRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/agents — moderation queue + general list
  fastify.get<{
    Querystring: { status?: string; tenantId?: string; page?: string; perPage?: string };
  }>("/", { preHandler }, async (request) => {
    const { status, tenantId } = request.query;
    const page = parseInt(request.query.page ?? "1", 10);
    const perPage = parseInt(request.query.perPage ?? "20", 10);
    const skip = (page - 1) * perPage;

    const where = {
      deletedAt: null,
      ...(status && { status: status as import("@falai/db").AgentStatus }),
      ...(tenantId && { tenantId }),
    };

    const [agents, total] = await Promise.all([
      prisma.agent.findMany({
        where,
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        take: perPage, skip,
        include: {
          tenant: { select: { id: true, name: true } },
          _count: { select: { calls: true, versions: true } },
        },
      }),
      prisma.agent.count({ where }),
    ]);

    return {
      data: agents.map((a) => ({
        id: a.id, tenantId: a.tenantId, name: a.name,
        objective: a.description ?? "", systemPrompt: a.systemPrompt,
        status: a.status,
        reviewStatus: a.status === "PENDING_REVIEW" ? "PENDING_REVIEW"
          : a.isApproved ? "APPROVED" : a.status === "BLOCKED" ? "BLOCKED" : "APPROVED",
        language: a.language, maxCallSeconds: a.maxCallSeconds,
        reviewRejectionReason: null,
        submittedAt: a.updatedAt.toISOString(),
        createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
        tenant: a.tenant,
        tenantName: a.tenant.name,
      })),
      total, page, perPage,
    };
  });

  // GET /admin/agents/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, deletedAt: null },
      include: {
        tenant: { select: { id: true, name: true } },
        versions: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    return { agent };
  });

  // POST /admin/agents/:id/approve
  fastify.post<{ Params: { id: string } }>("/:id/approve", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status !== "PENDING_REVIEW") {
      return reply.status(400).send({ error: "Agente não está em revisão" });
    }

    await prisma.agent.update({
      where: { id: request.params.id },
      data: { status: "ACTIVE", isApproved: true, approvedBy: admin.sub },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "agent.approved",
      targetType: "Agent",
      targetId: agent.id,
      before: { status: "PENDING_REVIEW" } as object,
      after: { status: "ACTIVE", approvedBy: admin.sub } as object,
      ip: request.ip,
    });

    return { ok: true, status: "ACTIVE" };
  });

  // POST /admin/agents/:id/reject
  fastify.post<{ Params: { id: string } }>("/:id/reject", { preHandler }, async (request, reply) => {
    const body = rejectSchema.parse(request.body);
    const admin = request.adminUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status !== "PENDING_REVIEW") {
      return reply.status(400).send({ error: "Agente não está em revisão" });
    }

    await prisma.agent.update({
      where: { id: request.params.id },
      data: { status: "DRAFT" },
    });

    // Log the rejection reason as a SystemEvent (visible to ops team)
    await prisma.systemEvent.create({
      data: {
        severity: "INFO",
        source: "moderation",
        message: `Agent ${agent.id} (${agent.name}) rejected by ${admin.email}: ${body.reason}`,
        payload: { agentId: agent.id, tenantId: agent.tenantId, reason: body.reason, adminId: admin.sub },
      },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "agent.rejected",
      targetType: "Agent",
      targetId: agent.id,
      before: { status: "PENDING_REVIEW" } as object,
      after: { status: "DRAFT", reason: body.reason } as object,
      ip: request.ip,
    });

    return { ok: true, status: "DRAFT" };
  });

  // POST /admin/agents/:id/block
  fastify.post<{ Params: { id: string } }>("/:id/block", { preHandler }, async (request, reply) => {
    const body = rejectSchema.parse(request.body);
    const admin = request.adminUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });

    await prisma.agent.update({
      where: { id: request.params.id },
      data: { status: "BLOCKED" },
    });

    await prisma.systemEvent.create({
      data: {
        severity: "WARNING",
        source: "moderation",
        message: `Agent ${agent.id} (${agent.name}) BLOCKED by ${admin.email}: ${body.reason}`,
        payload: { agentId: agent.id, tenantId: agent.tenantId, reason: body.reason, adminId: admin.sub },
      },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "agent.blocked",
      targetType: "Agent",
      targetId: agent.id,
      before: { status: agent.status } as object,
      after: { status: "BLOCKED", reason: body.reason } as object,
      ip: request.ip,
    });

    return { ok: true, status: "BLOCKED" };
  });

  // POST /admin/agents/:id/simulate — text conversation for agent review (works for any status)
  fastify.post<{ Params: { id: string } }>("/:id/simulate", { preHandler }, async (request, reply) => {
    const body = simulateSchema.parse(request.body);

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });

    const result = await fastify.callEngine.simulateTurn({
      userText: body.userText,
      systemPrompt: agent.systemPrompt,
      history: body.history as Array<{ role: "human" | "agent" | "system"; text: string }>,
      variables: (body.variables ?? {}) as Record<string, unknown>,
    });

    return {
      agentName: agent.name,
      agentStatus: agent.status,
      userText: body.userText,
      reply: result.reply,
      action: result.action,
      llmMs: result.llmMs,
    };
  });
};
