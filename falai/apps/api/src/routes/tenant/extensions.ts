import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { extensionWebEndpointId } from "@falai/providers";
import { decryptSecret } from "../../services/crypto.service.js";
import { config } from "../../config.js";
import { registerExtensions } from "../shared/extensions.js";

export const tenantExtensionsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // Lista, detalhe, criar, editar, reset SIP e apagar — o mesmo código que o
  // backoffice usa; ver routes/shared/extensions.ts.
  registerExtensions(fastify, {
    base: "",
    preHandler,
    listConfig: { feature: ["telephony", "webphone"] },
    ctx: async (request, reply, write) => {
      const { tenantId, role, sub } = request.tenantUser!;
      if (write && role !== "OWNER" && role !== "ADMIN") {
        reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir extensões" });
        return null;
      }
      return { tenantId, actorType: "TENANT_USER", actorId: sub };
    },
  });

  // GET /tenant/extensions/:id/webphone-credentials — credenciais prontas a
  // usar no JsSIP do CRM (endpoint WebRTC, não o hardphone). Sem
  // requireManager: qualquer agente do tenant pode pedir a extensão que
  // escolheu no dropdown do webphone, tal como já podia usá-la no
  // click-to-call (DirectCallPage).
  fastify.get<{ Params: { extId: string } }>("/:extId/webphone-credentials", { preHandler, config: { feature: "webphone" } }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const ext = await prisma.extension.findFirst({ where: { id: request.params.extId, tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });
    if (!ext.isActive) return reply.status(400).send({ error: "Extensão inactiva" });
    if (!config.PUBLIC_WEBPHONE_WSS_URL || !config.PUBLIC_WEBPHONE_SIP_DOMAIN) {
      return reply.status(503).send({ error: "Webphone não configurado neste ambiente" });
    }

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: sub,
      action: "tenant.extension.webphone_credentials_read",
      targetType: "Extension",
      targetId: ext.id,
      ip: request.ip,
    });

    return {
      // Nome do ENDPOINT web (não o sipAuthUser cru) — é isto que o PJSIP
      // casa no REGISTER (endpoint_identifier_order=...,username,...) e o que
      // vai no URI/From do JsSIP.
      sipUser: extensionWebEndpointId(ext.sipAuthUser),
      // Utilizador do Digest: o endpoint web reutiliza o objecto `auth` do
      // hardphone, cujo username é o sipAuthUser CRU (sem prefixo extweb_).
      sipAuthUser: ext.sipAuthUser,
      sipAuthSecret: decryptSecret(ext.sipAuthSecret),
      wsUri: config.PUBLIC_WEBPHONE_WSS_URL,
      sipDomain: config.PUBLIC_WEBPHONE_SIP_DOMAIN,
      displayName: ext.displayName,
      number: ext.number,
    };
  });
};
