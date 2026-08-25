import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { buildAdapterForModel, invalidateModelCache } from "../../services/modelResolver.service.js";

/**
 * Agentes por API pública.
 *
 * A leitura já existia. A escrita é o que faltava para o produto API_BYOM
 * funcionar sem UI nossa: o cliente cria o agente, aponta-o ao modelo dele,
 * simula, e submete a aprovação. Pôr em ACTIVE continua a ser só nosso.
 */

const AGENT_FIELDS = {
  id: true, name: true, description: true, status: true, language: true,
  ttsVoiceId: true, sttModel: true, maxCallSeconds: true, maxTurnSeconds: true,
  escalationNumber: true, variablesSchema: true, modelId: true,
  createdAt: true, updatedAt: true,
} as const;

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().min(20),
  ttsVoiceId: z.string().min(1),
  language: z.string().default("pt-PT"),
  maxTurnSeconds: z.number().int().min(10).max(300).default(30),
  maxCallSeconds: z.number().int().min(30).max(3600).default(300),
  escalationNumber: z.string().optional(),
  variablesSchema: z.record(z.unknown()).optional(),
  /** Modelo do cliente a usar. Ausente/null = motor da plataforma. */
  modelId: z.string().nullable().optional(),
});

const updateSchema = createSchema.partial();

const simulateSchema = z.object({
  history: z
    .array(z.object({ role: z.enum(["human", "agent", "system"]), text: z.string() }))
    .default([]),
  userText: z.string().min(1).max(1000),
  variables: z.record(z.unknown()).optional(),
});

/** Confirma que o modelo é deste tenant. Impede apontar ao modelo de outro. */
async function assertOwnModel(tenantId: string, modelId: string): Promise<string | null> {
  const model = await prisma.tenantModel.findFirst({
    where: { id: modelId, tenantId, deletedAt: null },
    select: { id: true },
  });
  return model ? null : "modelId não existe ou não pertence a esta conta.";
}

export async function v1AgentsRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Leitura ───────────────────────────────────────────────────────────────
  fastify.get("/v1/agents", { preHandler: [fastify.verifyScope("agents:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;

    const agents = await prisma.agent.findMany({
      where: { tenantId, deletedAt: null },
      select: {
        id: true, name: true, description: true, status: true, language: true,
        maxCallSeconds: true, maxTurnSeconds: true, modelId: true,
        createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return reply.send({ data: agents });
  });

  fastify.get("/v1/agents/:id", { preHandler: [fastify.verifyScope("agents:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const agent = await prisma.agent.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: AGENT_FIELDS,
    });

    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    return reply.send(agent);
  });

  // ── Criar ─────────────────────────────────────────────────────────────────
  fastify.post("/v1/agents", { preHandler: [fastify.verifyScope("agents:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid agent", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // Limite do plano — o mesmo que a UI aplica em /tenant/agents.
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { plan: { select: { maxAgents: true } } },
    });
    if (!tenant) return reply.status(404).send({ error: "Tenant not found" });

    const agentCount = await prisma.agent.count({ where: { tenantId, deletedAt: null } });
    if (agentCount >= tenant.plan.maxAgents) {
      return reply.status(409).send({
        error: `Limite de agentes atingido (${tenant.plan.maxAgents} no plano actual).`,
      });
    }

    if (body.modelId) {
      const problem = await assertOwnModel(tenantId, body.modelId);
      if (problem) return reply.status(400).send({ error: problem });
    }

    const agent = await prisma.agent.create({
      data: {
        tenantId,
        name: body.name,
        systemPrompt: body.systemPrompt,
        ttsVoiceId: body.ttsVoiceId,
        language: body.language,
        maxTurnSeconds: body.maxTurnSeconds,
        maxCallSeconds: body.maxCallSeconds,
        status: "DRAFT",
        ...(body.description !== undefined && { description: body.description }),
        ...(body.escalationNumber !== undefined && { escalationNumber: body.escalationNumber }),
        ...(body.variablesSchema !== undefined && { variablesSchema: body.variablesSchema as object }),
        ...(body.modelId != null && { modelId: body.modelId }),
      },
      select: AGENT_FIELDS,
    });

    await fastify.audit({
      actorType: "API_KEY",
      actorId: request.apiKey!.id,
      tenantId,
      action: "agent.created",
      targetType: "Agent",
      targetId: agent.id,
      after: { name: agent.name, modelId: agent.modelId },
      ip: request.ip,
    });

    return reply.status(201).send(agent);
  });

  // ── Alterar ───────────────────────────────────────────────────────────────
  fastify.patch("/v1/agents/:id", { preHandler: [fastify.verifyScope("agents:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const existing = await prisma.agent.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, status: true, systemPrompt: true, modelId: true },
    });
    if (!existing) return reply.status(404).send({ error: "Agent not found" });

    if (existing.status === "BLOCKED") {
      return reply.status(409).send({
        error: "Este agente foi bloqueado pela plataforma. Fala com o suporte.",
      });
    }

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid agent", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    if (body.modelId) {
      const problem = await assertOwnModel(tenantId, body.modelId);
      if (problem) return reply.status(400).send({ error: problem });
    }

    // Guarda a versão anterior do prompt antes de a substituir — é o histórico
    // que serve a moderação (mesmo comportamento de /tenant/agents).
    const promptChanged = body.systemPrompt !== undefined && body.systemPrompt !== existing.systemPrompt;
    if (promptChanged) {
      await prisma.agentVersion.create({
        data: {
          agentId: existing.id,
          systemPrompt: existing.systemPrompt,
          changedBy: `api_key:${request.apiKey!.id}`,
        },
      });
    }

    // Mudar o prompt ou o modelo de um agente aprovado tira-o de produção: o
    // que aprovámos foi aquela configuração. Volta a DRAFT e re-submete.
    const modelChanged = body.modelId !== undefined && body.modelId !== existing.modelId;
    const needsReapproval =
      (promptChanged || modelChanged) && (existing.status === "ACTIVE" || existing.status === "PENDING_REVIEW");

    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.systemPrompt !== undefined && { systemPrompt: body.systemPrompt }),
        ...(body.ttsVoiceId !== undefined && { ttsVoiceId: body.ttsVoiceId }),
        ...(body.language !== undefined && { language: body.language }),
        ...(body.maxTurnSeconds !== undefined && { maxTurnSeconds: body.maxTurnSeconds }),
        ...(body.maxCallSeconds !== undefined && { maxCallSeconds: body.maxCallSeconds }),
        ...(body.escalationNumber !== undefined && { escalationNumber: body.escalationNumber }),
        ...(body.variablesSchema !== undefined && { variablesSchema: body.variablesSchema as object }),
        ...(body.modelId !== undefined && { modelId: body.modelId }),
        ...(needsReapproval && { status: "DRAFT", isApproved: false, approvedBy: null }),
      },
      select: AGENT_FIELDS,
    });

    // O agente pode ter mudado de modelo — a resolução em cache já não vale.
    invalidateModelCache(agent.id);

    await fastify.audit({
      actorType: "API_KEY",
      actorId: request.apiKey!.id,
      tenantId,
      action: "agent.updated",
      targetType: "Agent",
      targetId: agent.id,
      before: { status: existing.status, modelId: existing.modelId },
      after: { status: agent.status, modelId: agent.modelId },
      ip: request.ip,
    });

    return reply.send(agent);
  });

  // ── Submeter a aprovação ──────────────────────────────────────────────────
  fastify.post("/v1/agents/:id/submit", { preHandler: [fastify.verifyScope("agents:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const agent = await prisma.agent.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, status: true, modelId: true, model: { select: { status: true, name: true } } },
    });
    if (!agent) return reply.status(404).send({ error: "Agent not found" });

    if (agent.status === "BLOCKED") return reply.status(409).send({ error: "Agente bloqueado pela plataforma." });
    if (agent.status === "PENDING_REVIEW") return reply.status(409).send({ error: "Já está em revisão." });
    if (agent.status === "ACTIVE") return reply.status(409).send({ error: "Já está aprovado." });

    // Um agente aprovado que aponte para um modelo bloqueado seria uma
    // aprovação sem efeito — mais vale dizer já qual é o problema.
    if (agent.model && agent.model.status === "BLOCKED") {
      return reply.status(409).send({
        error: `O modelo "${agent.model.name}" está bloqueado. Aponta o agente a outro modelo antes de submeter.`,
      });
    }

    await prisma.agent.update({ where: { id }, data: { status: "PENDING_REVIEW" } });
    invalidateModelCache(id);

    await fastify.audit({
      actorType: "API_KEY",
      actorId: request.apiKey!.id,
      tenantId,
      action: "agent.submitted_review",
      targetType: "Agent",
      targetId: id,
      before: { status: agent.status },
      after: { status: "PENDING_REVIEW" },
      ip: request.ip,
    });

    return reply.send({ ok: true, status: "PENDING_REVIEW" });
  });

  // ── Simular ───────────────────────────────────────────────────────────────
  // O sandbox do cliente: conversa em texto, sem telefonia e sem custo de voz.
  // Funciona com o agente em DRAFT, que é o objectivo — testar antes de submeter.
  // Os guardrails correm na mesma, para ele ver ao que fica sujeito.
  fastify.post("/v1/agents/:id/simulate", { preHandler: [fastify.verifyScope("agents:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const parsed = simulateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    const agent = await prisma.agent.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        id: true, name: true, status: true, systemPrompt: true, modelId: true,
        model: { select: { id: true, status: true, maxReplyChars: true } },
      },
    });
    if (!agent) return reply.status(404).send({ error: "Agent not found" });

    // No simulador o modelo do cliente é usado seja qual for o estado dele —
    // é a única forma de ele afinar antes da aprovação. O que continua a não
    // acontecer é isto servir uma chamada real.
    const llm = agent.model && agent.model.status !== "BLOCKED"
      ? await buildAdapterForModel(agent.model.id)
      : null;

    try {
      const result = await fastify.callEngine.simulateTurn({
        userText: body.userText,
        systemPrompt: agent.systemPrompt,
        history: body.history,
        variables: (body.variables ?? {}) as Record<string, unknown>,
        tenantId,
        ...(llm !== null && { llm }),
        ...(agent.model?.maxReplyChars !== undefined && { maxReplyChars: agent.model.maxReplyChars }),
      });

      return reply.send({
        agentId: agent.id,
        agentStatus: agent.status,
        // Diz de onde veio a resposta: sem isto, um modelo em BLOCKED responder
        // pelo motor da plataforma parecia o modelo dele a funcionar.
        engine: llm ? "tenant_model" : "platform",
        userText: body.userText,
        reply: result.reply,
        action: result.action,
        llmMs: result.llmMs,
        guardrailFlags: result.guardrailFlags,
      });
    } catch (err) {
      // O endpoint do cliente falhou. Aqui devolve-se o erro em cru, ao
      // contrário de uma chamada real onde se fala a frase de recurso: quem
      // está a afinar precisa da mensagem verdadeira.
      return reply.status(502).send({
        error: "O modelo não respondeu",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
