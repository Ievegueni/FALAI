import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import type { AdminRole, TenantRole } from "@falai/shared";

export interface AdminJwtPayload {
  sub: string;
  email: string;
  role: AdminRole;
  type: "admin";
}

export interface TenantJwtPayload {
  sub: string;       // TenantUser.id
  tenantId: string;
  email: string;
  role: TenantRole;
  type: "tenant";
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
        request.adminUser = request.user;
      } catch (err) {
        reply.send(err);
      }
    }
  );
});
