import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { syncCdrOnWebhook } from "../../services/pbxCdr.service.js";

/**
 * Webhook por tenant para o produto CRM (BYO-PBX). Cada cliente configura o
 * "Webhook Event Push" do PBX dele a apontar para /webhooks/pbx/:token.
 * O token identifica e autentica o tenant. Ao receber um evento, dispara um
 * sync de CDR imediato (com debounce), para as chamadas aparecerem no CRM em segundos.
 */
export const pbxWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { token: string }; Body: Record<string, unknown> }>(
    "/:token",
    async (request, reply) => {
      const tenant = await prisma.tenant.findUnique({
        where: { pbxWebhookToken: request.params.token },
        select: { id: true },
      });
      // Responde sempre 200 para o PBX não reencaminhar; ignora silenciosamente se o token não bater
      if (!tenant) {
        fastify.log.warn({ ip: request.ip }, "pbx.webhook.unknown_token");
        return reply.status(200).send({ errcode: 0, errmsg: "OK" });
      }

      const payload = request.body ?? {};
      fastify.log.info({ tenantId: tenant.id, event: payload["event"] }, "pbx.webhook.received");

      // Dispara sync do CDR sem bloquear a resposta ao PBX
      void syncCdrOnWebhook(fastify, tenant.id);

      return reply.status(200).send({ errcode: 0, errmsg: "OK" });
    }
  );
};
