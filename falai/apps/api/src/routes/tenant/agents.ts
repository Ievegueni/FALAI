import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import {
  compileSystemPrompt,
  type AgentEditorFields,
} from "../../services/agentCompiler.js";
import type { TurnMessage } from "@falai/providers";

const editorFieldsSchema = z.object({
  companyName: z.string().max(100).optional(),
  objective: z.string().min(10).max(1000),
  tone: z.string().min(2).max(200),
  dataToCollect: z
    .array(z.object({ field: z.string().min(1), required: z.boolean().optional() }))
    .default([]),
  neverSay: z.array(z.string().min(1)).default([]),
  additionalInstructions: z.string().max(2000).optional(),
});

const createSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("structured"),
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional(),
    editorFields: editorFieldsSchema,
    ttsVoiceId: z.string().min(1),
    language: z.string().default("pt-PT"),
    maxTurnSeconds: z.number().int().min(10).max(300).default(30),
    maxCallSeconds: z.number().int().min(30).max(3600).default(300),
    escalationNumber: z.string().optional(),
    variablesSchema: z.record(z.unknown()).optional(),
  }),
  z.object({
    mode: z.literal("raw"),
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional(),
    systemPrompt: z.string().min(20),
    ttsVoiceId: z.string().min(1),
    language: z.string().default("pt-PT"),
    maxTurnSeconds: z.number().int().min(10).max(300).default(30),
    maxCallSeconds: z.number().int().min(30).max(3600).default(300),
    escalationNumber: z.string().optional(),
    variablesSchema: z.record(z.unknown()).optional(),
  }),
]);

const updateSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  mode: z.enum(["structured", "raw"]).optional(),
  editorFields: editorFieldsSchema.optional(),
  systemPrompt: z.string().min(20).optional(),
  ttsVoiceId: z.string().min(1).optional(),
  language: z.string().optional(),
  maxTurnSeconds: z.number().int().min(10).max(300).optional(),
  maxCallSeconds: z.number().int().min(30).max(3600).optional(),
  escalationNumber: z.string().optional(),
  variablesSchema: z.record(z.unknown()).optional(),
});

const simulateSchema = z.object({
  history: z
    .array(z.object({ role: z.enum(["human", "agent", "system"]), text: z.string() }))
    .optional()
    .default([]),
  userText: z.string().min(1).max(1000),
  variables: z.record(z.unknown()).optional(),
});

export const tenantAgentsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/agents
  fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    "/",
    { preHandler },
    async (request) => {
      const { tenantId } = request.tenantUser!;
      const { status, limit = "50", offset = "0" } = request.query;

      const agents = await prisma.agent.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(status && { status: status as import("@falai/db").AgentStatus }),
        },
        orderBy: { updatedAt: "desc" },
        take: parseInt(limit, 10),
        skip: parseInt(offset, 10),
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          isApproved: true,
          language: true,
          ttsVoiceId: true,
          maxTurnSeconds: true,
          maxCallSeconds: true,
          escalationNumber: true,
          variablesSchema: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { calls: true, versions: true } },
        },
      });

      const total = await prisma.agent.count({
        where: {
          tenantId,
          deletedAt: null,
          ...(status && { status: status as import("@falai/db").AgentStatus }),
        },
      });

      return { agents, total };
    }
  );

  // POST /tenant/agents
  fastify.post("/", { preHandler }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { tenantId, sub: userId } = request.tenantUser!;

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { plan: { select: { maxAgents: true } } },
    });

    const agentCount = await prisma.agent.count({ where: { tenantId, deletedAt: null } });
    if (agentCount >= tenant.plan.maxAgents) {
      return reply.status(400).send({
        error: `Limite de agentes atingido (${tenant.plan.maxAgents} no plano actual)`,
      });
    }

    let systemPrompt: string;
    let editorMeta: AgentEditorFields | null = null;

    if (body.mode === "structured") {
      editorMeta = body.editorFields as AgentEditorFields;
      systemPrompt = compileSystemPrompt(editorMeta);
    } else {
      systemPrompt = body.systemPrompt;
    }

    const baseVariablesSchema = body.variablesSchema ?? {};
    const variablesSchema = editorMeta
      ? { ...baseVariablesSchema, _editor: { mode: "structured", fields: editorMeta } }
      : baseVariablesSchema;

    const agent = await prisma.agent.create({
      data: {
        tenantId,
        name: body.name,
        ...(body.description !== undefined && { description: body.description }),
        systemPrompt,
        ttsVoiceId: body.ttsVoiceId,
        language: body.language,
        maxTurnSeconds: body.maxTurnSeconds,
        maxCallSeconds: body.maxCallSeconds,
        ...(body.escalationNumber !== undefined && { escalationNumber: body.escalationNumber }),
        variablesSchema: variablesSchema as object,
        status: "DRAFT",
      },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "agent.created",
      targetType: "Agent",
      targetId: agent.id,
      after: { name: agent.name, mode: body.mode } as object,
      ip: request.ip,
    });

    return reply.status(201).send({ agent });
  });

  // GET /tenant/agents/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
      include: {
        versions: { orderBy: { createdAt: "desc" }, take: 20 },
        _count: { select: { calls: true } },
      },
    });

    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    return { agent };
  });

  // PATCH /tenant/agents/:id
  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const body = updateSchema.parse(request.body);
    const { tenantId, sub: userId } = request.tenantUser!;

    const existing = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
    });
    if (!existing) return reply.status(404).send({ error: "Agente não encontrado" });

    if (existing.status === "BLOCKED") {
      return reply.status(403).send({ error: "Agente bloqueado não pode ser editado" });
    }

    // Determine new systemPrompt
    let newSystemPrompt: string | undefined;
    let editorMeta: AgentEditorFields | null = null;

    if (body.mode === "structured" && body.editorFields) {
      editorMeta = body.editorFields as AgentEditorFields;
      newSystemPrompt = compileSystemPrompt(editorMeta);
    } else if (body.mode === "raw" && body.systemPrompt) {
      newSystemPrompt = body.systemPrompt;
    } else if (body.editorFields && !body.mode) {
      editorMeta = body.editorFields as AgentEditorFields;
      newSystemPrompt = compileSystemPrompt(editorMeta);
    } else if (body.systemPrompt && !body.mode) {
      newSystemPrompt = body.systemPrompt;
    }

    const promptChanged = newSystemPrompt !== undefined && newSystemPrompt !== existing.systemPrompt;

    // Save a version when the systemPrompt changes
    if (promptChanged) {
      await prisma.agentVersion.create({
        data: {
          agentId: existing.id,
          systemPrompt: existing.systemPrompt,
          changedBy: userId,
        },
      });
    }

    // If an ACTIVE agent's prompt changes, it must go back to PENDING_REVIEW
    let newStatus: import("@falai/db").AgentStatus | undefined;
    if (promptChanged && existing.status === "ACTIVE") {
      newStatus = "DRAFT";
    }

    // Build variablesSchema including editor meta
    let newVariablesSchema = body.variablesSchema;
    if (editorMeta && newVariablesSchema === undefined) {
      const prev = (existing.variablesSchema as Record<string, unknown>) ?? {};
      newVariablesSchema = { ...prev, _editor: { mode: "structured", fields: editorMeta } };
    }

    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(newSystemPrompt !== undefined && { systemPrompt: newSystemPrompt }),
        ...(body.ttsVoiceId !== undefined && { ttsVoiceId: body.ttsVoiceId }),
        ...(body.language !== undefined && { language: body.language }),
        ...(body.maxTurnSeconds !== undefined && { maxTurnSeconds: body.maxTurnSeconds }),
        ...(body.maxCallSeconds !== undefined && { maxCallSeconds: body.maxCallSeconds }),
        ...(body.escalationNumber !== undefined && { escalationNumber: body.escalationNumber }),
        ...(newVariablesSchema !== undefined && { variablesSchema: newVariablesSchema as object }),
        ...(newStatus !== undefined && { status: newStatus, isApproved: false }),
      },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "agent.updated",
      targetType: "Agent",
      targetId: agent.id,
      before: { systemPrompt: existing.systemPrompt, status: existing.status } as object,
      after: { promptChanged, newStatus } as object,
      ip: request.ip,
    });

    return { agent };
  });

  // DELETE /tenant/agents/:id (soft delete)
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const existing = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
    });
    if (!existing) return reply.status(404).send({ error: "Agente não encontrado" });

    await prisma.agent.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: "PAUSED" },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "agent.deleted",
      targetType: "Agent",
      targetId: existing.id,
      ip: request.ip,
    });

    return { ok: true };
  });

  // POST /tenant/agents/:id/submit-review
  fastify.post<{ Params: { id: string } }>("/:id/submit-review", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status !== "DRAFT") {
      return reply.status(400).send({
        error: `Apenas agentes em DRAFT podem ser submetidos para revisão (estado actual: ${agent.status})`,
      });
    }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: "PENDING_REVIEW" },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "agent.submitted_review",
      targetType: "Agent",
      targetId: agent.id,
      after: { status: "PENDING_REVIEW" } as object,
      ip: request.ip,
    });

    return { ok: true, status: "PENDING_REVIEW" };
  });

  // POST /tenant/agents/:id/pause
  fastify.post<{ Params: { id: string } }>("/:id/pause", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status !== "ACTIVE") {
      return reply.status(400).send({ error: "Apenas agentes ACTIVE podem ser pausados" });
    }

    await prisma.agent.update({ where: { id: agent.id }, data: { status: "PAUSED" } });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "agent.paused",
      targetType: "Agent",
      targetId: agent.id,
      ip: request.ip,
    });

    return { ok: true, status: "PAUSED" };
  });

  // POST /tenant/agents/:id/resume
  fastify.post<{ Params: { id: string } }>("/:id/resume", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status !== "PAUSED") {
      return reply.status(400).send({ error: "Apenas agentes PAUSED podem ser retomados" });
    }

    await prisma.agent.update({ where: { id: agent.id }, data: { status: "ACTIVE" } });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "agent.resumed",
      targetType: "Agent",
      targetId: agent.id,
      ip: request.ip,
    });

    return { ok: true, status: "ACTIVE" };
  });

  // GET /tenant/agents/:id/versions
  fastify.get<{ Params: { id: string } }>("/:id/versions", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });

    const versions = await prisma.agentVersion.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: "desc" },
    });

    return { versions };
  });

  // POST /tenant/agents/:id/simulate — text conversation (only ACTIVE or DRAFT agents)
  fastify.post<{ Params: { id: string } }>("/:id/simulate", { preHandler }, async (request, reply) => {
    const body = simulateSchema.parse(request.body);
    const { tenantId } = request.tenantUser!;

    const agent = await prisma.agent.findFirst({
      where: { id: request.params.id, tenantId, deletedAt: null },
    });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status === "BLOCKED") {
      return reply.status(403).send({ error: "Agente bloqueado" });
    }

    const result = await fastify.callEngine.simulateTurn({
      userText: body.userText,
      systemPrompt: agent.systemPrompt,
      history: body.history as TurnMessage[],
      variables: (body.variables ?? {}) as Record<string, unknown>,
    });

    return {
      reply: result.reply,
      action: result.action,
      llmMs: result.llmMs,
    };
  });
};
