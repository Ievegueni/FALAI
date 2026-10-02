import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { hashPassword } from "../../services/auth.service.js";

const password = z.string().min(8, "A password deve ter pelo menos 8 caracteres").max(128);

// Nome, password nova, papel, extensão, grupos da extensão (onde atende) e — para SUPERVISOR — os grupos que supervisiona.
const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  password: password.optional(),
  role: z.enum(["ADMIN", "SUPERVISOR", "MEMBER", "VIEWER"]).optional(),
  extensionId: z.string().nullable().optional(),
  groupIds: z.array(z.string()).max(200).optional(),
  supervisedGroupIds: z.array(z.string()).max(200).optional(),
});

// O gestor cria o utilizador já com a password (sem convite por email).
const createSchema = updateSchema.extend({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(100),
  password,
  role: z.enum(["ADMIN", "SUPERVISOR", "MEMBER", "VIEWER"]),
});

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  twoFaSecret: true,
  createdAt: true,
  extensionId: true,
  extension: { select: { groups: { select: { groupId: true } } } },
  supervisedGroups: { select: { groupId: true } },
} as const;

function toTeamUser(u: {
  id: string;
  name: string;
  email: string;
  role: string;
  twoFaSecret: string | null;
  createdAt: Date;
  extensionId: string | null;
  extension: { groups: { groupId: string }[] } | null;
  supervisedGroups: { groupId: string }[];
}) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    twoFaEnabled: !!u.twoFaSecret,
    createdAt: u.createdAt,
    extensionId: u.extensionId,
    groupIds: u.extension?.groups.map((g) => g.groupId) ?? [],
    supervisedGroupIds: u.supervisedGroups.map((g) => g.groupId),
  };
}

export const tenantTeamRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  function requireManager(role: string, reply: import("fastify").FastifyReply): boolean {
    if (role !== "OWNER" && role !== "ADMIN") {
      reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir a equipa" });
      return false;
    }
    return true;
  }

  /** Valida a extensão (do tenant e livre) e filtra os grupos para os do tenant. */
  async function checkExtensionAndGroups(
    tenantId: string,
    userId: string | null,
    body: { extensionId?: string | null | undefined; groupIds?: string[] | undefined; supervisedGroupIds?: string[] | undefined },
  ): Promise<{ error: string; status: number } | { groupIds: string[] | null; supervisedGroupIds: string[] | null }> {
    if (body.extensionId) {
      const ext = await prisma.extension.findFirst({ where: { id: body.extensionId, tenantId }, select: { id: true } });
      if (!ext) return { status: 400, error: "Extensão inválida" };
      const taken = await prisma.tenantUser.findFirst({
        where: { extensionId: body.extensionId, ...(userId && { id: { not: userId } }) },
        select: { name: true },
      });
      if (taken) return { status: 409, error: `A extensão já está associada a ${taken.name}` };
    }
    const own = async (ids: string[] | undefined) =>
      ids ? (await prisma.extensionGroup.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } })).map((g) => g.id) : null;
    return { groupIds: await own(body.groupIds), supervisedGroupIds: await own(body.supervisedGroupIds) };
  }

  /** Grupos onde a extensão atende (os mesmos de Telefonia → Grupos). */
  async function setExtensionGroups(extensionId: string, groupIds: string[]) {
    await prisma.$transaction([
      prisma.extensionGroupMember.deleteMany({ where: { extensionId } }),
      prisma.extensionGroupMember.createMany({ data: groupIds.map((groupId) => ({ extensionId, groupId })) }),
    ]);
  }

  // GET /tenant/team — list members
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const users = await prisma.tenantUser.findMany({
      where: { tenantId },
      select: userSelect,
      orderBy: { createdAt: "asc" },
    });
    return users.map(toTeamUser);
  });

  // POST /tenant/team — cria o utilizador com password, papel, extensão e grupos
  fastify.post("/", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const body = createSchema.parse(request.body);
    const existing = await prisma.tenantUser.findUnique({ where: { email: body.email } });
    if (existing) return reply.status(409).send({ error: "Email já registado" });
    if (body.groupIds?.length && !body.extensionId) {
      return reply.status(400).send({ error: "Para atribuir grupos, escolha a extensão do utilizador" });
    }
    const checked = await checkExtensionAndGroups(tenantId, null, body);
    if ("error" in checked) return reply.status(checked.status).send({ error: checked.error });

    const created = await prisma.tenantUser.create({
      data: {
        tenantId,
        name: body.name,
        email: body.email,
        role: body.role,
        passwordHash: await hashPassword(body.password),
        ...(body.extensionId && { extensionId: body.extensionId }),
        ...(body.role === "SUPERVISOR" && checked.supervisedGroupIds && {
          supervisedGroups: { create: checked.supervisedGroupIds.map((groupId) => ({ groupId })) },
        }),
      },
      select: { id: true },
    });
    if (body.extensionId && checked.groupIds) await setExtensionGroups(body.extensionId, checked.groupIds);

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      action: "tenant.team.created",
      targetType: "TenantUser",
      targetId: created.id,
      ip: request.ip,
    });

    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: created.id }, select: userSelect });
    return reply.status(201).send(toTeamUser(user));
  });

  // PATCH /tenant/team/:userId — papel, extensão e grupos supervisionados
  fastify.patch<{ Params: { userId: string } }>("/:userId", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const body = updateSchema.parse(request.body);
    const target = await prisma.tenantUser.findFirst({ where: { id: request.params.userId, tenantId } });
    if (!target) return reply.status(404).send({ error: "Membro não encontrado" });
    if (body.role && target.role === "OWNER") return reply.status(400).send({ error: "Não é possível alterar o papel do OWNER" });

    const checked = await checkExtensionAndGroups(tenantId, target.id, body);
    if ("error" in checked) return reply.status(checked.status).send({ error: checked.error });
    const extensionId = body.extensionId !== undefined ? body.extensionId : target.extensionId;
    if (checked.groupIds?.length && !extensionId) {
      return reply.status(400).send({ error: "Para atribuir grupos, escolha a extensão do utilizador" });
    }

    await prisma.tenantUser.update({
      where: { id: target.id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.password && { passwordHash: await hashPassword(body.password) }),
        ...(body.role && { role: body.role }),
        ...(body.extensionId !== undefined && { extensionId: body.extensionId }),
        ...(checked.supervisedGroupIds && {
          supervisedGroups: { deleteMany: {}, create: checked.supervisedGroupIds.map((groupId) => ({ groupId })) },
        }),
      },
    });
    if (extensionId && checked.groupIds) await setExtensionGroups(extensionId, checked.groupIds);
    if (body.password) {
      await fastify.audit({
        actorType: "TENANT_USER",
        actorId: request.tenantUser!.sub,
        action: "tenant.team.password_reset",
        targetType: "TenantUser",
        targetId: target.id,
        ip: request.ip,
      });
    }

    const user = await prisma.tenantUser.findUniqueOrThrow({ where: { id: target.id }, select: userSelect });
    return toTeamUser(user);
  });

  // DELETE /tenant/team/:userId — remove a member
  fastify.delete<{ Params: { userId: string } }>("/:userId", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const target = await prisma.tenantUser.findFirst({ where: { id: request.params.userId, tenantId } });
    if (!target) return reply.status(404).send({ error: "Membro não encontrado" });
    if (target.role === "OWNER") return reply.status(400).send({ error: "Não é possível remover o OWNER" });
    if (target.id === sub) return reply.status(400).send({ error: "Não te podes remover a ti próprio" });

    await prisma.tenantUser.delete({ where: { id: target.id } });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: sub,
      action: "tenant.team.removed",
      targetType: "TenantUser",
      targetId: target.id,
      ip: request.ip,
    });

    return reply.status(204).send();
  });
};
