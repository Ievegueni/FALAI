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

        const claims = request.user as TenantJwtPayload;

        // O JWT dura 8h: revalida o utilizador e o papel contra a BD em cada
        // pedido — apagado deixa de entrar já, despromovido passa a ter o papel
        // novo. Substitui a leitura do tenant que já se fazia (mesma 1 query).
        const dbUser = await prisma.tenantUser.findUnique({
          where: { id: claims.sub },
          select: { tenantId: true, role: true, tenant: { select: { status: true, deletedAt: true } } },
        });
        if (!dbUser || dbUser.tenantId !== claims.tenantId) {
          return reply.status(401).send({ error: "Sessão inválida — utilizador já não existe" });
        }

        const { tenant } = dbUser;
        if (tenant.deletedAt || tenant.status === "SUSPENDED" || tenant.status === "CLOSED") {
          return reply.status(403).send({ error: "Conta de tenant inactiva ou suspensa" });
        }

        const user: TenantJwtPayload = { ...claims, role: dbUser.role };

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
