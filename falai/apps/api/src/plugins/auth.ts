import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "@falai/db";
import { config } from "../config.js";
import type { AdminRole, TenantRole } from "@falai/shared";

export interface AdminJwtPayload {
  sub: string;
  email: string;
  role: AdminRole;
  type: "admin";
  tv?: number; // tokenVersion; tokens antigos não o têm (= 0)
}

export interface TenantJwtPayload {
  sub: string;       // TenantUser.id
  tenantId: string;
  email: string;
  role: TenantRole;
  type: "tenant";
  tv?: number; // tokenVersion; tokens antigos não o têm (= 0)
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    adminUser?: AdminJwtPayload;
    tenantUser?: TenantJwtPayload;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AdminJwtPayload | TenantJwtPayload;
    user: AdminJwtPayload | TenantJwtPayload;
  }
}

export default fp(async (fastify) => {
  fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: "8h" },
  });

  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
        if (request.user.type !== "admin") {
          return reply.status(401).send({ error: "Not an admin session" });
        }

        // Revalida na BD: um admin removido não deve manter acesso até o token expirar
        const admin = request.user as AdminJwtPayload;
        // tokenVersion diferente = sessão terminada (password mudada, "sair de todos").
        const row = await prisma.adminUser.findUnique({ where: { id: admin.sub }, select: { tokenVersion: true } });
        if (!row || row.tokenVersion !== (admin.tv ?? 0)) {
          return reply.status(401).send({ error: "Sessão inválida" });
        }

        request.adminUser = admin;
      } catch {
        return reply.status(401).send({ error: "Não autenticado" });
      }
    }
  );
});
