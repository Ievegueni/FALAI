import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { scheduleTenantPbxSync } from "../../services/pbxSync.service.js";
import { assertTrunk, registerIvrRouting } from "../shared/ivrRouting.js";

const outboundCreate = z.object({
  name: z.string().min(2).max(64),
  trunkId: z.string().cuid(),
  dialPattern: z.string().max(128).optional().nullable(),
  callerId: z.string().max(64).optional().nullable(),
  priority: z.number().int().min(0).max(1000).optional(),
  extensionIds: z.array(z.string().cuid()).optional(),
});
const outboundUpdate = outboundCreate.partial();

export const tenantRoutingRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  function requireManager(role: string, reply: import("fastify").FastifyReply): boolean {
    if (role !== "OWNER" && role !== "ADMIN") {
      reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir rotas" });
      return false;
    }
    return true;
  }

  const outboundInclude = { trunk: { select: { id: true, name: true } }, permissions: { select: { extensionId: true } } } as const;

  // ── Rotas de saída ───────────────────────────────────────────────────────
  fastify.get("/outbound-routes", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const routes = await prisma.outboundRoute.findMany({ where: { tenantId }, orderBy: { priority: "asc" }, include: outboundInclude });
    return routes.map((r) => ({
      id: r.id, name: r.name, trunkId: r.trunkId, trunkName: r.trunk.name,
      dialPattern: r.dialPattern, callerId: r.callerId, priority: r.priority,
      extensionIds: r.permissions.map((p) => p.extensionId),
    }));
  });

  fastify.post("/outbound-routes", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = outboundCreate.parse(request.body);
    if (!(await assertTrunk(tenantId, body.trunkId))) return reply.status(400).send({ error: "Trunk inválido" });

    const dup = await prisma.outboundRoute.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (dup) return reply.status(409).send({ error: "Já existe uma rota com esse nome" });

    const exts = await prisma.extension.findMany({ where: { tenantId, id: { in: body.extensionIds ?? [] } }, select: { id: true } });
    const route = await prisma.outboundRoute.create({
      data: {
        tenantId, name: body.name, trunkId: body.trunkId,
        dialPattern: body.dialPattern ?? null, callerId: body.callerId ?? null, priority: body.priority ?? 0,
        permissions: { create: exts.map((e) => ({ extensionId: e.id })) },
      },
    });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.outbound_route.created", targetType: "OutboundRoute", targetId: route.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return reply.status(201).send({ id: route.id });
  });

  fastify.put<{ Params: { id: string } }>("/outbound-routes/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = outboundUpdate.parse(request.body);

    const existing = await prisma.outboundRoute.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Rota não encontrada" });
    if (body.trunkId && !(await assertTrunk(tenantId, body.trunkId))) return reply.status(400).send({ error: "Trunk inválido" });

    await prisma.$transaction(async (tx) => {
      if (body.extensionIds !== undefined) {
        const exts = await tx.extension.findMany({ where: { tenantId, id: { in: body.extensionIds } }, select: { id: true } });
        await tx.outboundRoutePermission.deleteMany({ where: { routeId: existing.id } });
        await tx.outboundRoutePermission.createMany({ data: exts.map((e) => ({ routeId: existing.id, extensionId: e.id })) });
      }
      await tx.outboundRoute.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.trunkId !== undefined ? { trunkId: body.trunkId } : {}),
          ...(body.dialPattern !== undefined ? { dialPattern: body.dialPattern } : {}),
          ...(body.callerId !== undefined ? { callerId: body.callerId } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
        },
      });
    });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.outbound_route.updated", targetType: "OutboundRoute", targetId: existing.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return { ok: true };
  });

  fastify.delete<{ Params: { id: string } }>("/outbound-routes/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const existing = await prisma.outboundRoute.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Rota não encontrada" });
    await prisma.outboundRoute.delete({ where: { id: existing.id } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.outbound_route.deleted", targetType: "OutboundRoute", targetId: existing.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return reply.status(204).send();
  });

  // Rotas de entrada e menus IVR — ver routes/shared/ivrRouting.ts
  registerIvrRouting(fastify, {
    base: "",
    preHandler,
    ctx: async (request, reply, write) => {
      const { tenantId, role, sub } = request.tenantUser!;
      if (write && !requireManager(role, reply)) return null;
      return { tenantId, actorType: "TENANT_USER", actorId: sub };
    },
  });
};
