import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { buildAdapterForModel, invalidateModel } from "../../services/modelResolver.service.js";

/**
 * Moderação dos modelos dos clientes (produto API_BYOM).
 *
 * Espelha routes/admin/agents-moderation.ts de propósito: mesmo ciclo
 * DRAFT → PENDING_REVIEW → ACTIVE/BLOCKED, mesma auditoria, mesmos SystemEvent.
 * A regra que interessa é uma só: nenhum modelo entra numa chamada real sem
 * status ACTIVE, e só nós lhe pomos esse status.
 */

const reasonSchema = z.object({ reason: z.string().min(10).max(500) });

const LIST_FIELDS = {
  id: true, tenantId: true, name: true, endpointUrl: true, protocol: true,
  modelName: true, authType: true, timeoutMs: true, maxReplyChars: true,
  status: true, approvedBy: true, lastHealthAt: true, lastLatencyMs: true,
  lastError: true, violations: true, createdAt: true, updatedAt: true,
} as const;

export const adminModelsModerationRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/models — fila de moderação + lista geral
  fastify.get<{
    Querystring: { status?: string; tenantId?: string; page?: string; perPage?: string };
  }>("/", { preHandler }, async (request) => {
    const { status, tenantId } = request.query;
    const page = parseInt(request.query.page ?? "1", 10);
    const perPage = parseInt(request.query.perPage ?? "20", 10);

    const where = {
      deletedAt: null,
      ...(status && { status: status as import("@falai/db").AgentStatus }),
      ...(tenantId && { tenantId }),
    };

    const [models, total] = await Promise.all([
      prisma.tenantModel.findMany({
        where,
        // PENDING_REVIEW primeiro: é a fila de trabalho, não uma lista qualquer.
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        take: perPage,
        skip: (page - 1) * perPage,
        select: {
          ...LIST_FIELDS,
          tenant: { select: { id: true, name: true } },
          _count: { select: { agents: true } },
        },
      }),
      prisma.tenantModel.count({ where }),
    ]);

    return { data: models, total, page, perPage };
  });

  // GET /admin/models/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const model = await prisma.tenantModel.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: {
        ...LIST_FIELDS,
        tenant: { select: { id: true, name: true } },
        agents: { select: { id: true, name: true, status: true } },
      },
    });
    if (!model) return reply.status(404).send({ error: "Modelo não encontrado" });
    return { model };
  });

  // POST /admin/models/:id/approve
  fastify.post<{ Params: { id: string } }>("/:id/approve", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;

    const model = await prisma.tenantModel.findFirst({
      where: { id: request.params.id, deletedAt: null },
    });
    if (!model) return reply.status(404).send({ error: "Modelo não encontrado" });
    if (model.status !== "PENDING_REVIEW") {
      return reply.status(400).send({ error: "Modelo não está em revisão" });
    }

    await prisma.tenantModel.update({
      where: { id: model.id },
      // Aprovar limpa o contador de violações: recomeça com a folha limpa.
      data: { status: "ACTIVE", approvedBy: admin.sub, violations: 0, lastError: null },
    });
    invalidateModel(model.id);

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      tenantId: model.tenantId,
      action: "model.approved",
      targetType: "TenantModel",
      targetId: model.id,
      before: { status: "PENDING_REVIEW" } as object,
      after: { status: "ACTIVE", approvedBy: admin.sub } as object,
      ip: request.ip,
    });

    return { ok: true, status: "ACTIVE" };
  });

  // POST /admin/models/:id/reject — volta para DRAFT, o cliente corrige e volta a submeter
  fastify.post<{ Params: { id: string } }>("/:id/reject", { preHandler }, async (request, reply) => {
    const body = reasonSchema.parse(request.body);
    const admin = request.adminUser!;

    const model = await prisma.tenantModel.findFirst({
      where: { id: request.params.id, deletedAt: null },
    });
    if (!model) return reply.status(404).send({ error: "Modelo não encontrado" });
    if (model.status !== "PENDING_REVIEW") {
      return reply.status(400).send({ error: "Modelo não está em revisão" });
    }

    await prisma.tenantModel.update({
      where: { id: model.id },
      data: { status: "DRAFT", lastError: body.reason },
    });
    invalidateModel(model.id);

    await prisma.systemEvent.create({
      data: {
        severity: "INFO",
        source: "moderation",
        tenantId: model.tenantId,
        message: `Modelo ${model.id} (${model.name}) rejeitado por ${admin.email}: ${body.reason}`,
        payload: { modelId: model.id, tenantId: model.tenantId, reason: body.reason, adminId: admin.sub },
      },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      tenantId: model.tenantId,
      action: "model.rejected",
      targetType: "TenantModel",
      targetId: model.id,
      before: { status: "PENDING_REVIEW" } as object,
      after: { status: "DRAFT", reason: body.reason } as object,
      ip: request.ip,
    });

    return { ok: true, status: "DRAFT" };
  });

  // POST /admin/models/:id/block — o kill switch. Vale de qualquer estado.
  fastify.post<{ Params: { id: string } }>("/:id/block", { preHandler }, async (request, reply) => {
    const body = reasonSchema.parse(request.body);
    const admin = request.adminUser!;

    const model = await prisma.tenantModel.findFirst({
      where: { id: request.params.id, deletedAt: null },
    });
    if (!model) return reply.status(404).send({ error: "Modelo não encontrado" });

    await prisma.tenantModel.update({
      where: { id: model.id },
      data: { status: "BLOCKED", lastError: body.reason },
    });

    // Corte imediato, incluindo as chamadas JÁ A DECORRER: elas resolveram o
    // modelo no arranque e guardaram-no na sessão, portanto sem isto
    // continuariam a falar por ele até desligarem.
    invalidateModel(model.id, { blockLiveCalls: true });

    await prisma.systemEvent.create({
      data: {
        severity: "WARNING",
        source: "moderation",
        tenantId: model.tenantId,
        message: `Modelo ${model.id} (${model.name}) BLOQUEADO por ${admin.email}: ${body.reason}`,
        payload: { modelId: model.id, tenantId: model.tenantId, reason: body.reason, adminId: admin.sub },
      },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      tenantId: model.tenantId,
      action: "model.blocked",
      targetType: "TenantModel",
      targetId: model.id,
      before: { status: model.status } as object,
      after: { status: "BLOCKED", reason: body.reason } as object,
      ip: request.ip,
    });

    return { ok: true, status: "BLOCKED" };
  });

  // POST /admin/models/:id/test — bate no endpoint do cliente e mede a latência
  fastify.post<{ Params: { id: string } }>("/:id/test", { preHandler }, async (request, reply) => {
    const model = await prisma.tenantModel.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!model) return reply.status(404).send({ error: "Modelo não encontrado" });

    const adapter = await buildAdapterForModel(model.id);
    if (!adapter) return reply.status(404).send({ error: "Modelo não encontrado" });

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

    return { ok: health.ok, latencyMs, details: health.details ?? null };
  });
};
