import type { FastifyPluginAsync } from "fastify";
import { prisma, Prisma } from "@falai/db";
import { z } from "zod";

const permissions = z.record(z.string(), z.unknown()); // matriz por módulo — ver docs/sip_trunk.md §4

const createSchema = z.object({
  name: z.string().min(2).max(64),
  permissions: permissions.default({}),
});
const updateSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  permissions: permissions.optional(),
});

export const tenantRolesRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  function requireManager(role: string, reply: import("fastify").FastifyReply): boolean {
    if (role !== "OWNER" && role !== "ADMIN") {
      reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir funções" });
      return false;
    }
    return true;
  }

  // GET /tenant/roles
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    return prisma.role.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: { _count: { select: { extensions: true } } },
    });
  });

  // POST /tenant/roles
  fastify.post("/", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = createSchema.parse(request.body);

    const dup = await prisma.role.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (dup) return reply.status(409).send({ error: "Já existe uma função com esse nome" });

    const created = await prisma.role.create({
      data: { tenantId, name: body.name, permissions: body.permissions as Prisma.InputJsonValue },
    });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.role.created", targetType: "Role", targetId: created.id, ip: request.ip });
    return reply.status(201).send(created);
  });

  // PUT /tenant/roles/:id
  fastify.put<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = updateSchema.parse(request.body);

    const existing = await prisma.role.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Função não encontrada" });

    if (body.name && body.name !== existing.name) {
      const dup = await prisma.role.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
      if (dup) return reply.status(409).send({ error: "Já existe uma função com esse nome" });
    }

    const updated = await prisma.role.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.permissions !== undefined ? { permissions: body.permissions as Prisma.InputJsonValue } : {}),
      },
    });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.role.updated", targetType: "Role", targetId: existing.id, ip: request.ip });
    return updated;
  });

  // DELETE /tenant/roles/:id
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const existing = await prisma.role.findFirst({ where: { id: request.params.id, tenantId }, include: { _count: { select: { extensions: true } } } });
    if (!existing) return reply.status(404).send({ error: "Função não encontrada" });
    if (existing._count.extensions > 0) {
      return reply.status(400).send({ error: "Há extensões a usar esta função. Reatribui-as antes de a eliminar." });
    }

    await prisma.role.delete({ where: { id: existing.id } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.role.deleted", targetType: "Role", targetId: existing.id, ip: request.ip });
    return reply.status(204).send();
  });
};
