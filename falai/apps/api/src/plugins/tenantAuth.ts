import fp from "fastify-plugin";
import type { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "@falai/db";
import type { TenantJwtPayload } from "./auth.js";

declare module "fastify" {
  interface FastifyInstance {
    verifyTenant: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (fastify) => {
  fastify.decorate(
    "verifyTenant",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
        if (request.user.type !== "tenant") {
          return reply.status(401).send({ error: "Not a tenant session" });
        }

        const user = request.user as TenantJwtPayload;

        const tenant = await prisma.tenant.findUnique({
          where: { id: user.tenantId },
          select: { status: true, deletedAt: true },
        });

        if (!tenant || tenant.deletedAt || tenant.status === "SUSPENDED" || tenant.status === "CLOSED") {
          return reply.status(403).send({ error: "Conta de tenant inactiva ou suspensa" });
        }

        request.tenantUser = user;
      } catch (err) {
        reply.send(err);
      }
    }
  );
});
