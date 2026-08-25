import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { isSafeEndpointUrl, assertSafeEndpointUrl } from "@falai/providers";
import { encryptSecret } from "../../services/crypto.service.js";
import { buildAdapterForModel, invalidateModel } from "../../services/modelResolver.service.js";

/**
 * Modelos do próprio cliente (produto API_BYOM), geridos por API.
 *
 * O cliente não tem UI nossa: cria, testa e submete o modelo daqui, a partir do
 * CRM dele. O que ele NÃO pode fazer é pôr um modelo em produção — `status` só
 * chega a ACTIVE pela mão de um humano nosso, em /admin/models. É essa a
 * fronteira do produto.
 *
 * Segredos entram mas nunca saem: `authSecret` e `signingSecret` são guardados
 * encriptados e a API devolve apenas se estão definidos.
 */

const PROTOCOLS = ["FALAI_TURN", "OPENAI_CHAT", "ANTHROPIC_MESSAGES"] as const;
const AUTH_TYPES = ["BEARER", "HEADER", "NONE"] as const;

/** Tecto do timeout: acima disto o silêncio na chamada é insuportável. */
const MAX_TIMEOUT_MS = 10_000;

const endpointUrl = z
  .string()
  .trim()
  .min(1)
  .refine(isSafeEndpointUrl, {
    message:
      "Endpoint não aceite. Tem de ser um https:// público — endereços internos, " +
      "portas fora de 443/80/8080/8443 e credenciais no URL são recusados.",
  });

const createSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    endpointUrl,
    protocol: z.enum(PROTOCOLS).default("FALAI_TURN"),
    modelName: z.string().trim().max(200).optional(),
    authType: z.enum(AUTH_TYPES).default("BEARER"),
    authSecret: z.string().min(1).max(500).optional(),
    authHeader: z.string().trim().max(100).optional(),
    signingSecret: z.string().min(8).max(500).optional(),
    timeoutMs: z.number().int().min(500).max(MAX_TIMEOUT_MS).default(4000),
    maxReplyChars: z.number().int().min(50).max(1500).default(800),
  })
  .superRefine((body, ctx) => {
    if (body.protocol !== "FALAI_TURN" && !body.modelName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelName"],
        message: `O protocolo ${body.protocol} exige modelName (o nome do modelo a pedir ao teu endpoint).`,
      });
    }
    if (body.authType === "HEADER" && !body.authHeader) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authHeader"],
        message: "authType=HEADER exige authHeader (o nome do cabeçalho a enviar).",
      });
    }
    if (body.authType !== "NONE" && !body.authSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authSecret"],
        message: `authType=${body.authType} exige authSecret.`,
      });
    }
  });

const updateSchema = createSchema.innerType().partial();

/** O que sai na API. Nunca inclui segredos. */
const PUBLIC_FIELDS = {
  id: true, name: true, endpointUrl: true, protocol: true, modelName: true,
  authType: true, authHeader: true, timeoutMs: true, maxReplyChars: true,
  status: true, lastHealthAt: true, lastLatencyMs: true, lastError: true,
  violations: true, createdAt: true, updatedAt: true,
} as const;

type ModelRow = { authSecret?: string | null; signingSecret?: string | null } & Record<string, unknown>;

function shape(model: ModelRow) {
  const { authSecret, signingSecret, ...rest } = model;
  return { ...rest, authSecretSet: Boolean(authSecret), signingSecretSet: Boolean(signingSecret) };
}

export async function v1ModelsRoutes(fastify: FastifyInstance): Promise<void> {
  // ── Listar ────────────────────────────────────────────────────────────────
  fastify.get("/v1/models", { preHandler: [fastify.verifyScope("models:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const models = await prisma.tenantModel.findMany({
      where: { tenantId, deletedAt: null },
      select: { ...PUBLIC_FIELDS, authSecret: true, signingSecret: true },
      orderBy: { createdAt: "desc" },
    });
    return reply.send({ data: models.map(shape) });
  });

  fastify.get("/v1/models/:id", { preHandler: [fastify.verifyScope("models:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const model = await prisma.tenantModel.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: {
        ...PUBLIC_FIELDS,
        authSecret: true,
        signingSecret: true,
        agents: { select: { id: true, name: true, status: true } },
      },
    });
    if (!model) return reply.status(404).send({ error: "Model not found" });
    return reply.send(shape(model));
  });

  // ── Criar ─────────────────────────────────────────────────────────────────
  fastify.post("/v1/models", { preHandler: [fastify.verifyScope("models:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid model", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    const model = await prisma.tenantModel.create({
      data: {
        tenantId,
        name: body.name,
        endpointUrl: body.endpointUrl,
        protocol: body.protocol,
        authType: body.authType,
        timeoutMs: body.timeoutMs,
        maxReplyChars: body.maxReplyChars,
        // Nasce em DRAFT: pode ser testado e simulado, nunca serve chamadas.
        status: "DRAFT",
        ...(body.modelName !== undefined && { modelName: body.modelName }),
        ...(body.authHeader !== undefined && { authHeader: body.authHeader }),
        ...(body.authSecret !== undefined && { authSecret: encryptSecret(body.authSecret) }),
        ...(body.signingSecret !== undefined && { signingSecret: encryptSecret(body.signingSecret) }),
      },
      select: { ...PUBLIC_FIELDS, authSecret: true, signingSecret: true },
    });

    await fastify.audit({
      actorType: "API_KEY",
      actorId: request.apiKey!.id,
      tenantId,
      action: "model.created",
      targetType: "TenantModel",
      targetId: model.id,
      after: { name: model.name, endpointUrl: model.endpointUrl, protocol: model.protocol },
      ip: request.ip,
    });

    return reply.status(201).send(shape(model));
  });

  // ── Alterar ───────────────────────────────────────────────────────────────
  fastify.patch("/v1/models/:id", { preHandler: [fastify.verifyScope("models:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const existing = await prisma.tenantModel.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, status: true, endpointUrl: true, protocol: true, modelName: true, authType: true, authHeader: true },
    });
    if (!existing) return reply.status(404).send({ error: "Model not found" });

    // Um modelo bloqueado por nós não se desbloqueia por edição do cliente.
    if (existing.status === "BLOCKED") {
      return reply.status(409).send({
        error: "Este modelo foi bloqueado pela plataforma. Fala com o suporte antes de o alterar.",
      });
    }

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid model", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // Coerência dos campos combinados, tendo em conta o que já está guardado.
    const protocol = body.protocol ?? existing.protocol;
    const modelName = body.modelName ?? existing.modelName;
    if (protocol !== "FALAI_TURN" && !modelName) {
      return reply.status(400).send({ error: `O protocolo ${protocol} exige modelName.` });
    }
    const authType = body.authType ?? existing.authType;
    const authHeader = body.authHeader ?? existing.authHeader;
    if (authType === "HEADER" && !authHeader) {
      return reply.status(400).send({ error: "authType=HEADER exige authHeader." });
    }

    const model = await prisma.tenantModel.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.endpointUrl !== undefined && { endpointUrl: body.endpointUrl }),
        ...(body.protocol !== undefined && { protocol: body.protocol }),
        ...(body.modelName !== undefined && { modelName: body.modelName }),
        ...(body.authType !== undefined && { authType: body.authType }),
        ...(body.authHeader !== undefined && { authHeader: body.authHeader }),
        ...(body.authSecret !== undefined && { authSecret: encryptSecret(body.authSecret) }),
        ...(body.signingSecret !== undefined && { signingSecret: encryptSecret(body.signingSecret) }),
        ...(body.timeoutMs !== undefined && { timeoutMs: body.timeoutMs }),
        ...(body.maxReplyChars !== undefined && { maxReplyChars: body.maxReplyChars }),
        // Mexer num modelo já aprovado tira-o de produção: o que nós aprovámos
        // foi aquela configuração, não esta. Volta a DRAFT e re-submete.
        ...(existing.status === "ACTIVE" || existing.status === "PENDING_REVIEW"
          ? { status: "DRAFT", approvedBy: null }
          : {}),
      },
      select: { ...PUBLIC_FIELDS, authSecret: true, signingSecret: true },
    });

    invalidateModel(model.id);

    await fastify.audit({
      actorType: "API_KEY",
      actorId: request.apiKey!.id,
      tenantId,
      action: "model.updated",
      targetType: "TenantModel",
      targetId: model.id,
      before: { status: existing.status, endpointUrl: existing.endpointUrl },
      after: { status: model.status, endpointUrl: model.endpointUrl },
      ip: request.ip,
    });

    return reply.send(shape(model));
  });

  // ── Testar ────────────────────────────────────────────────────────────────
  // Bate no endpoint dele e mede a latência. Funciona em qualquer estado — é
  // como ele afina antes de submeter.
  fastify.post("/v1/models/:id/test", { preHandler: [fastify.verifyScope("models:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const model = await prisma.tenantModel.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, endpointUrl: true },
    });
    if (!model) return reply.status(404).send({ error: "Model not found" });

    // Revalidação: o URL pode ter sido aceite quando as regras eram outras.
    try {
      assertSafeEndpointUrl(model.endpointUrl);
    } catch (err) {
      return reply.status(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = await buildAdapterForModel(model.id);
    if (!adapter) return reply.status(404).send({ error: "Model not found" });

    const startedAt = Date.now();
    const health = await adapter.healthCheck();
    const latencyMs = Date.now() - startedAt;

    await prisma.tenantModel.update({
      where: { id: model.id },
      data: {
        lastHealthAt: new Date(),
        lastLatencyMs: latencyMs,
        lastError: health.ok ? null : (health.details ?? "falha desconhecida"),
      },
    });

    return reply.send({
      ok: health.ok,
      latencyMs,
      details: health.details ?? null,
      // O que ele precisa de saber: numa chamada isto soma-se a STT e TTS.
      ...(health.ok && latencyMs > 2000 && {
        warning:
          "Latência alta para voz. Somada a transcrição e síntese, o silêncio percebido pelo " +
          "chamador passa dos 3 segundos.",
      }),
    });
  });

  // ── Submeter a aprovação ──────────────────────────────────────────────────
  fastify.post("/v1/models/:id/submit", { preHandler: [fastify.verifyScope("models:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const model = await prisma.tenantModel.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, name: true, status: true, lastHealthAt: true, lastError: true, endpointUrl: true },
    });
    if (!model) return reply.status(404).send({ error: "Model not found" });

    if (model.status === "BLOCKED") {
      return reply.status(409).send({ error: "Modelo bloqueado pela plataforma." });
    }
    if (model.status === "PENDING_REVIEW") {
      return reply.status(409).send({ error: "Este modelo já está em revisão." });
    }
    if (model.status === "ACTIVE") {
      return reply.status(409).send({ error: "Este modelo já está aprovado." });
    }
    // Não se manda para a fila de moderação um endpoint que nunca respondeu:
    // poupa o tempo de quem revê e devolve o erro a quem o pode corrigir.
    if (!model.lastHealthAt) {
      return reply.status(400).send({
        error: "Testa o modelo antes de o submeter (POST /v1/models/:id/test).",
      });
    }
    // `lastHealthAt` só diz que houve um teste, não que ele passou — sem isto um
    // endpoint partido chega à fila na mesma, que é justamente o que se queria evitar.
    if (model.lastError) {
      return reply.status(400).send({
        error: "O último teste a este modelo falhou. Corrige o endpoint e testa outra vez antes de submeter.",
        details: model.lastError,
      });
    }

    await prisma.tenantModel.update({ where: { id }, data: { status: "PENDING_REVIEW" } });
    invalidateModel(id);

    await prisma.systemEvent.create({
      data: {
        severity: "INFO",
        source: "models",
        tenantId,
        message: `Modelo "${model.name}" submetido a aprovação`,
        payload: { modelId: model.id, endpointUrl: model.endpointUrl },
      },
    });

    await fastify.audit({
      actorType: "API_KEY",
      actorId: request.apiKey!.id,
      tenantId,
      action: "model.submitted",
      targetType: "TenantModel",
      targetId: model.id,
      before: { status: model.status },
      after: { status: "PENDING_REVIEW" },
      ip: request.ip,
    });

    return reply.send({ ok: true, status: "PENDING_REVIEW" });
  });

  // ── Apagar ────────────────────────────────────────────────────────────────
  fastify.delete("/v1/models/:id", { preHandler: [fastify.verifyScope("models:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const model = await prisma.tenantModel.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, _count: { select: { agents: true } } },
    });
    if (!model) return reply.status(404).send({ error: "Model not found" });

    if (model._count.agents > 0) {
      return reply.status(409).send({
        error: `Este modelo está a ser usado por ${model._count.agents} agente(s). Muda-os primeiro.`,
      });
    }

    await prisma.tenantModel.update({ where: { id }, data: { deletedAt: new Date() } });
    invalidateModel(id);

    await fastify.audit({
      actorType: "API_KEY",
      actorId: request.apiKey!.id,
      tenantId,
      action: "model.deleted",
      targetType: "TenantModel",
      targetId: id,
      ip: request.ip,
    });

    return reply.status(204).send();
  });
}
