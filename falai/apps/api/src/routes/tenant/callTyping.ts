import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { isOpsManager } from "../../services/userScope.js";
import {
  legGroupIds,
  loadCategories,
  typingStatus,
  validateTyping,
  visibleCategories,
} from "../../services/callTyping.service.js";

/**
 * Tipificação de chamadas (melhoria 2/4) — ver services/callTyping.service.ts.
 * Configuração (categorias, obrigatoriedade, prazo): OWNER/ADMIN.
 * Registo e edição: qualquer utilizador do tenant que use o webphone.
 */

// Tipificação é configuração da operação: também o gestor (MANAGER).
const isAdmin = isOpsManager;

const categorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  // Só nas categorias (não nas subcategorias). Vazio = todos os grupos.
  groupIds: z.array(z.string()).max(100).optional(),
});
const categoryUpdateSchema = categorySchema.omit({ parentId: true }).partial().extend({ isActive: z.boolean().optional() });
const settingsSchema = z.object({
  typingRequired: z.boolean().optional(),
  typingMaxSecs: z.number().int().min(10).max(1800).optional(),
});
const typingSchema = z.object({
  categoryId: z.string(),
  subcategoryId: z.string().nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export const tenantCallTypingRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // ── Categorias ────────────────────────────────────────────────────────────

  // GET /tenant/call-categories — lista plana (categorias e subcategorias), com grupos
  fastify.get("/tenant/call-categories", { preHandler }, async (request) => {
    return { data: await loadCategories(request.tenantUser!.tenantId) };
  });

  fastify.post("/tenant/call-categories", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isAdmin(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = categorySchema.parse(request.body);
    const parentId = body.parentId ?? null;
    if (parentId) {
      const parent = await prisma.callCategory.findFirst({ where: { id: parentId, tenantId, parentId: null } });
      if (!parent) return reply.status(400).send({ error: "Categoria-mãe inválida (só há 2 níveis)" });
    }
    const dup = await prisma.callCategory.findFirst({ where: { tenantId, parentId, name: body.name } });
    if (dup) return reply.status(409).send({ error: "Já existe com esse nome" });
    const groupIds = parentId ? [] : await ownGroupIds(tenantId, body.groupIds ?? []);
    const row = await prisma.callCategory.create({
      data: {
        tenantId,
        parentId,
        name: body.name,
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        groups: { create: groupIds.map((groupId) => ({ groupId })) },
      },
    });
    return reply.status(201).send(row);
  });

  fastify.patch<{ Params: { id: string } }>("/tenant/call-categories/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isAdmin(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = categoryUpdateSchema.parse(request.body);
    const cat = await prisma.callCategory.findFirst({ where: { id: request.params.id, tenantId } });
    if (!cat) return reply.status(404).send({ error: "Categoria não encontrada" });
    if (body.name && body.name !== cat.name) {
      const dup = await prisma.callCategory.findFirst({ where: { tenantId, parentId: cat.parentId, name: body.name } });
      if (dup) return reply.status(409).send({ error: "Já existe com esse nome" });
    }
    const groupIds = body.groupIds && !cat.parentId ? await ownGroupIds(tenantId, body.groupIds) : null;
    await prisma.callCategory.update({
      where: { id: cat.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(groupIds && { groups: { deleteMany: {}, create: groupIds.map((groupId) => ({ groupId })) } }),
      },
    });
    return { ok: true };
  });

  // ── Configuração ──────────────────────────────────────────────────────────

  fastify.get("/tenant/call-typing/settings", { preHandler }, async (request) => {
    return prisma.tenant.findUniqueOrThrow({
      where: { id: request.tenantUser!.tenantId },
      select: { typingRequired: true, typingMaxSecs: true },
    });
  });

  fastify.patch("/tenant/call-typing/settings", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isAdmin(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = settingsSchema.parse(request.body);
    return prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(body.typingRequired !== undefined && { typingRequired: body.typingRequired }),
        ...(body.typingMaxSecs !== undefined && { typingMaxSecs: body.typingMaxSecs }),
      },
      select: { typingRequired: true, typingMaxSecs: true },
    });
  });

  // ── Registo pelo agente ───────────────────────────────────────────────────

  // GET /tenant/call-legs/untyped?extensionId= — chamadas atendidas por esta
  // extensão nos últimos 7 dias ainda sem tipificação (inclui as do telefone físico).
  fastify.get<{ Querystring: { extensionId?: string } }>("/tenant/call-legs/untyped", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const { extensionId } = request.query;
    if (!extensionId) return reply.status(400).send({ error: "extensionId em falta" });
    const now = new Date();
    const legs = await prisma.callLeg.findMany({
      where: {
        tenantId,
        extensionId,
        outcome: "ANSWERED",
        endedAt: { not: null },
        typedAt: null,
        ringStartedAt: { gte: new Date(now.getTime() - 7 * 24 * 3600 * 1000) },
      },
      orderBy: { ringStartedAt: "desc" },
      take: 50,
      select: { id: true, ringStartedAt: true, endedAt: true, outcome: true, typedAt: true, wrapUpEndsAt: true, call: { select: { fromNumber: true } } },
    });
    return {
      data: legs.map((l) => ({
        id: l.id,
        from: l.call.fromNumber,
        at: l.ringStartedAt,
        status: typingStatus(l, now),
        wrapUpEndsAt: l.wrapUpEndsAt,
      })),
    };
  });

  // GET /tenant/call-legs/:id/typing — estado + categorias que este agente pode usar
  fastify.get<{ Params: { id: string } }>("/tenant/call-legs/:id/typing", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const leg = await findLeg(tenantId, request.params.id);
    if (!leg) return reply.status(404).send({ error: "Chamada não encontrada" });
    const categories = visibleCategories(await loadCategories(tenantId), await legGroupIds(leg));
    return {
      id: leg.id,
      from: leg.call.fromNumber,
      status: typingStatus(leg, new Date()),
      wrapUpEndsAt: leg.wrapUpEndsAt,
      categoryId: leg.categoryId,
      subcategoryId: leg.subcategoryId,
      note: leg.typingNote,
      categories: categories.map(({ id, parentId, name }) => ({ id, parentId, name })),
    };
  });

  // PUT /tenant/call-legs/:id/typing — tipificar ou corrigir. Correcções ficam
  // no AuditLog (quem, quando, antes/depois).
  fastify.put<{ Params: { id: string } }>("/tenant/call-legs/:id/typing", { preHandler }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const body = typingSchema.parse(request.body);
    const leg = await findLeg(tenantId, request.params.id);
    if (!leg) return reply.status(404).send({ error: "Chamada não encontrada" });
    if (leg.outcome !== "ANSWERED") return reply.status(409).send({ error: "Só se tipificam chamadas atendidas" });

    const visible = visibleCategories(await loadCategories(tenantId), await legGroupIds(leg));
    const subcategoryId = body.subcategoryId ?? null;
    const invalid = validateTyping(visible, body.categoryId, subcategoryId);
    if (invalid) return reply.status(400).send({ error: invalid });

    const after = { categoryId: body.categoryId, subcategoryId, typingNote: body.note ?? null };
    await prisma.callLeg.update({
      where: { id: leg.id },
      data: { ...after, typedById: sub, typedAt: leg.typedAt ?? new Date() },
    });
    if (leg.typedAt) {
      await fastify.audit({
        actorType: "TENANT_USER",
        actorId: sub,
        tenantId,
        action: "call_leg.typing_changed",
        targetType: "CallLeg",
        targetId: leg.id,
        before: { categoryId: leg.categoryId, subcategoryId: leg.subcategoryId, typingNote: leg.typingNote, typedById: leg.typedById },
        after,
        ip: request.ip,
      });
    }
    return { ok: true, edited: Boolean(leg.typedAt) };
  });
};

function findLeg(tenantId: string, id: string) {
  return prisma.callLeg.findFirst({
    where: { id, tenantId },
    select: {
      id: true,
      outcome: true,
      endedAt: true,
      extensionId: true,
      groupId: true,
      categoryId: true,
      subcategoryId: true,
      typingNote: true,
      typedAt: true,
      typedById: true,
      wrapUpEndsAt: true,
      call: { select: { fromNumber: true } },
    },
  });
}

/** Só aceita grupos do próprio tenant (ids de outro tenant são ignorados). */
async function ownGroupIds(tenantId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.extensionGroup.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
  return rows.map((r) => r.id);
}
