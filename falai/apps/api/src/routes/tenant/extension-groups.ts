import type { FastifyPluginAsync } from "fastify";
import { prisma, Prisma } from "@falai/db";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(2).max(64),
  isDefault: z.boolean().optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  memberIds: z.array(z.string().cuid()).optional(),
});
const updateSchema = createSchema.partial();

export const tenantExtensionGroupsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  function requireManager(role: string, reply: import("fastify").FastifyReply): boolean {
    if (role !== "OWNER" && role !== "ADMIN") {
      reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir grupos" });
      return false;
    }
    return true;
  }

  function serialize(g: {
    id: string; name: string; isDefault: boolean; permissions: unknown;
    members: { extension: { id: string; number: string; callerId: string } }[];
  }) {
    return {
      id: g.id,
      name: g.name,
      isDefault: g.isDefault,
      permissions: g.permissions,
      members: g.members.map((m) => m.extension),
      total: g.members.length,
    };
  }
  const include = { members: { include: { extension: { select: { id: true, number: true, callerId: true } } } } } satisfies Prisma.ExtensionGroupInclude;

  async function loadGroup(id: string) {
    return prisma.extensionGroup.findUniqueOrThrow({ where: { id }, include });
  }

  // Valida que todas as extensões pertencem ao tenant; devolve as válidas
  async function validMembers(tenantId: string, memberIds: string[]): Promise<string[]> {
    if (memberIds.length === 0) return [];
    const found = await prisma.extension.findMany({ where: { tenantId, id: { in: memberIds } }, select: { id: true } });
    return found.map((e) => e.id);
  }

  // GET /tenant/extension-groups
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const groups = await prisma.extensionGroup.findMany({ where: { tenantId }, orderBy: { name: "asc" }, include });
    return groups.map(serialize);
  });

  // POST /tenant/extension-groups
  fastify.post("/", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = createSchema.parse(request.body);

    const dup = await prisma.extensionGroup.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (dup) return reply.status(409).send({ error: "Já existe um grupo com esse nome" });

    const members = await validMembers(tenantId, body.memberIds ?? []);
    const created = await prisma.extensionGroup.create({
      data: {
        tenantId,
        name: body.name,
        isDefault: body.isDefault ?? false,
        ...(body.permissions !== undefined ? { permissions: body.permissions as Prisma.InputJsonValue } : {}),
        members: { create: members.map((extensionId) => ({ extensionId })) },
      },
      include,
    });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.extension_group.created", targetType: "ExtensionGroup", targetId: created.id, ip: request.ip });
    return reply.status(201).send(serialize(created));
  });

  // PUT /tenant/extension-groups/:id — atualiza dados e substitui membros (se enviados)
  fastify.put<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = updateSchema.parse(request.body);

    const existing = await prisma.extensionGroup.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Grupo não encontrado" });

    if (body.name && body.name !== existing.name) {
      const dup = await prisma.extensionGroup.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
      if (dup) return reply.status(409).send({ error: "Já existe um grupo com esse nome" });
    }

    await prisma.$transaction(async (tx) => {
      if (body.memberIds !== undefined) {
        const members = await validMembers(tenantId, body.memberIds);
        await tx.extensionGroupMember.deleteMany({ where: { groupId: existing.id } });
        await tx.extensionGroupMember.createMany({ data: members.map((extensionId) => ({ extensionId, groupId: existing.id })) });
      }
      await tx.extensionGroup.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          ...(body.permissions !== undefined ? { permissions: body.permissions as Prisma.InputJsonValue } : {}),
        },
      });
    });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.extension_group.updated", targetType: "ExtensionGroup", targetId: existing.id, ip: request.ip });
    return serialize(await loadGroup(existing.id));
  });

  // DELETE /tenant/extension-groups/:id
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const existing = await prisma.extensionGroup.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Grupo não encontrado" });

    await prisma.extensionGroup.delete({ where: { id: existing.id } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.extension_group.deleted", targetType: "ExtensionGroup", targetId: existing.id, ip: request.ip });
    return reply.status(204).send();
  });
};
