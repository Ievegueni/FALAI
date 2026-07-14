import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "crypto";
import { prisma } from "@falai/db";
import { z } from "zod";
import { hashPassword } from "../../services/auth.service.js";

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});

const updateRoleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  twoFaSecret: true,
  createdAt: true,
} as const;

function toTeamUser(u: { id: string; name: string; email: string; role: string; twoFaSecret: string | null; createdAt: Date }) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    twoFaEnabled: !!u.twoFaSecret,
    createdAt: u.createdAt,
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

  // POST /tenant/team/invite — add a member
  fastify.post("/invite", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const body = inviteSchema.parse(request.body);

    const existing = await prisma.tenantUser.findUnique({ where: { email: body.email } });
    if (existing) return reply.status(409).send({ error: "Email já registado" });

    // Temporary password — the member resets it via a password-reset flow.
    const tempPassword = randomBytes(12).toString("base64url");
    const user = await prisma.tenantUser.create({
      data: {
        tenantId,
        name: body.name,
        email: body.email,
        role: body.role,
        passwordHash: await hashPassword(tempPassword),
      },
      select: userSelect,
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      action: "tenant.team.invited",
      targetType: "TenantUser",
      targetId: user.id,
      ip: request.ip,
    });

    return reply.status(201).send(toTeamUser(user));
  });

  // PATCH /tenant/team/:userId — change role
  fastify.patch<{ Params: { userId: string } }>("/:userId", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const body = updateRoleSchema.parse(request.body);
    const target = await prisma.tenantUser.findFirst({ where: { id: request.params.userId, tenantId } });
    if (!target) return reply.status(404).send({ error: "Membro não encontrado" });
    if (target.role === "OWNER") return reply.status(400).send({ error: "Não é possível alterar o papel do OWNER" });

    const user = await prisma.tenantUser.update({
      where: { id: target.id },
      data: { role: body.role },
      select: userSelect,
    });
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
