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

        // VIEWER é só consulta, em todas as rotas — não depende de cada rota se
        // lembrar de verificar. Excepção: a própria sessão (2FA, password).
        if (user.role === "VIEWER" && !["GET", "HEAD"].includes(request.method) && !request.url.startsWith("/tenant/auth/")) {
          return reply.status(403).send({ error: "O seu papel só permite consultar" });
        }

        request.tenantUser = user;
      } catch {
        return reply.status(401).send({ error: "Não autenticado" });
      }
    }
  );
});
