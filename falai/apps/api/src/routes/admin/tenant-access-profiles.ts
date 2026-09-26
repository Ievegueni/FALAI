import type { FastifyPluginAsync } from "fastify";
import { prisma, Prisma } from "@falai/db";
import { z } from "zod";
import { FEATURE_KEYS, FEATURE_LABELS, FEATURE_HINTS } from "../../services/features.js";
import { ACCESS_LEVELS, sanitizePermissions, invalidateUserPermissions } from "../../services/accessProfiles.js";

/**
 * Perfis de acesso ao CRM de um cliente — ver services/accessProfiles.ts.
 * Só a Comunica os cria e edita; o cliente vê o efeito no CRM (menu e 403).
 */

const permissions = z.record(z.string(), z.enum(ACCESS_LEVELS));

const createSchema = z.object({
  name: z.string().trim().min(2).max(64),
  description: z.string().trim().max(255).nullable().optional(),
  permissions: permissions.default({}),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(64).optional(),
    description: z.string().trim().max(255).nullable().optional(),
    permissions: permissions.optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined || b.permissions !== undefined, {
    message: "Nada para actualizar",
  });

const assignSchema = z.object({ accessProfileId: z.string().nullable() });

const PROFILE_FIELDS = {
  id: true, name: true, description: true, permissions: true, createdAt: true, updatedAt: true,
  _count: { select: { users: true } },
} as const;

function shape<T extends { permissions: unknown }>(p: T) {
  return { ...p, permissions: sanitizePermissions(p.permissions) };
}

export const adminTenantAccessProfilesRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  async function tenantExists(id: string): Promise<boolean> {
    return !!(await prisma.tenant.findFirst({ where: { id, deletedAt: null }, select: { id: true } }));
  }

  // GET /admin/tenants/:id/access-profiles — perfis + módulos da matriz
  fastify.get<{ Params: { id: string } }>("/:id/access-profiles", { preHandler }, async (request, reply) => {
    if (!(await tenantExists(request.params.id))) return reply.status(404).send({ error: "Tenant não encontrado" });
    const profiles = await prisma.accessProfile.findMany({
      where: { tenantId: request.params.id },
      orderBy: { name: "asc" },
      select: PROFILE_FIELDS,
    });
    return {
      profiles: profiles.map(shape),
      modules: [
        {
          key: "dashboard", label: "Dashboard", hint: "Saldo, custos e totais de chamadas da conta",
          levels: ["none", "read"],
        },
        ...FEATURE_KEYS.map((key) => ({ key, label: FEATURE_LABELS[key], hint: FEATURE_HINTS[key] })),
      ],
    };
  });

  // POST /admin/tenants/:id/access-profiles
  fastify.post<{ Params: { id: string } }>("/:id/access-profiles", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const tenantId = request.params.id;
    if (!(await tenantExists(tenantId))) return reply.status(404).send({ error: "Tenant não encontrado" });
    const body = createSchema.parse(request.body);

    const dup = await prisma.accessProfile.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (dup) return reply.status(409).send({ error: "Já existe um perfil com esse nome" });

    const created = await prisma.accessProfile.create({
      data: {
        tenantId,
        name: body.name,
        description: body.description ?? null,
        permissions: sanitizePermissions(body.permissions) as Prisma.InputJsonValue,
      },
      select: PROFILE_FIELDS,
    });
    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.access_profile.created",
      targetType: "AccessProfile", targetId: created.id,
      after: { tenantId, name: created.name, permissions: created.permissions } as object, ip: request.ip,
    });
    return reply.status(201).send(shape(created));
  });

  // PUT /admin/tenants/:id/access-profiles/:profileId
  fastify.put<{ Params: { id: string; profileId: string } }>(
    "/:id/access-profiles/:profileId",
    { preHandler },
    async (request, reply) => {
      const admin = request.adminUser!;
      const { id: tenantId, profileId } = request.params;
      const body = updateSchema.parse(request.body);

      const existing = await prisma.accessProfile.findFirst({ where: { id: profileId, tenantId } });
      if (!existing) return reply.status(404).send({ error: "Perfil não encontrado" });

      if (body.name && body.name !== existing.name) {
        const dup = await prisma.accessProfile.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
        if (dup) return reply.status(409).send({ error: "Já existe um perfil com esse nome" });
      }

      const updated = await prisma.accessProfile.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.permissions !== undefined && {
            permissions: sanitizePermissions(body.permissions) as Prisma.InputJsonValue,
          }),
        },
        select: PROFILE_FIELDS,
      });
      invalidateUserPermissions();
      await fastify.audit({
        actorType: "ADMIN", actorId: admin.sub, action: "tenant.access_profile.updated",
        targetType: "AccessProfile", targetId: existing.id,
        before: { name: existing.name, permissions: existing.permissions } as object,
        after: { name: updated.name, permissions: updated.permissions } as object, ip: request.ip,
      });
      return shape(updated);
    },
  );

  // DELETE /admin/tenants/:id/access-profiles/:profileId
  fastify.delete<{ Params: { id: string; profileId: string } }>(
    "/:id/access-profiles/:profileId",
    { preHandler },
    async (request, reply) => {
      const admin = request.adminUser!;
      const { id: tenantId, profileId } = request.params;
      const existing = await prisma.accessProfile.findFirst({
        where: { id: profileId, tenantId },
        select: { id: true, name: true, _count: { select: { users: true } } },
      });
      if (!existing) return reply.status(404).send({ error: "Perfil não encontrado" });
      // Apagar deixaria os utilizadores sem restrição nenhuma: obriga a reatribuir primeiro.
      if (existing._count.users > 0) {
        return reply.status(400).send({ error: "Há utilizadores com este perfil. Reatribui-os antes de o eliminar." });
      }
      await prisma.accessProfile.delete({ where: { id: existing.id } });
      await fastify.audit({
        actorType: "ADMIN", actorId: admin.sub, action: "tenant.access_profile.deleted",
        targetType: "AccessProfile", targetId: existing.id,
        before: { tenantId, name: existing.name } as object, ip: request.ip,
      });
      return reply.status(204).send();
    },
  );

  // PUT /admin/tenants/:id/users/:userId/access-profile — atribui (ou tira, com null)
  fastify.put<{ Params: { id: string; userId: string } }>(
    "/:id/users/:userId/access-profile",
    { preHandler },
    async (request, reply) => {
      const admin = request.adminUser!;
      const { id: tenantId, userId } = request.params;
      const { accessProfileId } = assignSchema.parse(request.body);

      const user = await prisma.tenantUser.findFirst({ where: { id: userId, tenantId }, select: { id: true, accessProfileId: true } });
      if (!user) return reply.status(404).send({ error: "Utilizador não encontrado" });
      if (accessProfileId) {
        const profile = await prisma.accessProfile.findFirst({ where: { id: accessProfileId, tenantId }, select: { id: true } });
        if (!profile) return reply.status(400).send({ error: "Perfil de acesso inválido" });
      }

      await prisma.tenantUser.update({ where: { id: user.id }, data: { accessProfileId } });
      invalidateUserPermissions(user.id);
      await fastify.audit({
        actorType: "ADMIN", actorId: admin.sub, action: "tenant.user.access_profile_changed",
        targetType: "TenantUser", targetId: user.id,
        before: { accessProfileId: user.accessProfileId } as object,
        after: { accessProfileId } as object, ip: request.ip,
      });
      return { ok: true, accessProfileId };
    },
  );
};
