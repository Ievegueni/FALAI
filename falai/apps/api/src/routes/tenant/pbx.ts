import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { randomBytes } from "crypto";
import { encryptSecret } from "../../services/crypto.service.js";
import { getTenantTelephony, invalidateTenantTelephony } from "../../services/tenantTelephony.service.js";

const saveSchema = z.object({
  baseUrl: z.string().url("Base URL inválida"),
  clientId: z.string().min(1),
  // Secret opcional: só actualiza se enviado (permite guardar sem reescrever o segredo)
  clientSecret: z.string().min(1).optional(),
  extension: z.string().min(1).optional(),
});

export const tenantPbxRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  async function loadTenant(tenantId: string) {
    return prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        pbxBaseUrl: true,
        pbxClientId: true,
        pbxClientSecret: true,
        pbxExtension: true,
        pbxConnected: true,
        pbxWebhookToken: true,
        plan: { select: { productType: true } },
      },
    });
  }

  // Base URL pública da API (para compor o URL de webhook que o cliente cola no PBX)
  function publicApiUrl(request: { protocol: string; headers: Record<string, unknown> }): string {
    const env = process.env["PUBLIC_API_URL"];
    if (env) return env.replace(/\/$/, "");
    const host = request.headers["host"] as string | undefined;
    return `${request.protocol}://${host ?? "localhost:3000"}`;
  }

  // GET /tenant/pbx — configuração actual (sem expor o segredo)
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    let t = await loadTenant(tenantId);

    // Gera o token de webhook na primeira leitura (só para planos CRM)
    if (t.plan.productType === "CRM_BYO_PBX" && !t.pbxWebhookToken) {
      const token = randomBytes(24).toString("hex");
      await prisma.tenant.update({ where: { id: tenantId }, data: { pbxWebhookToken: token } });
      t = await loadTenant(tenantId);
    }

    return {
      productType: t.plan.productType,
      config: {
        baseUrl: t.pbxBaseUrl,
        clientId: t.pbxClientId,
        extension: t.pbxExtension,
        secretSet: !!t.pbxClientSecret,
        connected: t.pbxConnected,
        webhookUrl: t.pbxWebhookToken ? `${publicApiUrl(request)}/webhooks/pbx/${t.pbxWebhookToken}` : null,
      },
    };
  });

  // PUT /tenant/pbx — guardar credenciais do PBX próprio
  fastify.put("/", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const t = await loadTenant(tenantId);
    if (t.plan.productType !== "CRM_BYO_PBX") {
      return reply.status(403).send({ error: "O plano actual não permite configurar um PBX próprio" });
    }
    const body = saveSchema.parse(request.body);

    // Exige um segredo definido (novo ou já existente)
    if (!body.clientSecret && !t.pbxClientSecret) {
      return reply.status(400).send({ error: "Indique o Client Secret do PBX" });
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        pbxBaseUrl: body.baseUrl.replace(/\/$/, ""),
        pbxClientId: body.clientId,
        ...(body.clientSecret ? { pbxClientSecret: encryptSecret(body.clientSecret) } : {}),
        ...(body.extension !== undefined ? { pbxExtension: body.extension } : {}),
        pbxConnected: false, // requer novo teste após alterar
      },
    });
    invalidateTenantTelephony(tenantId);

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      action: "tenant.pbx.updated",
      targetType: "Tenant",
      targetId: tenantId,
      ip: request.ip,
    });

    return { ok: true };
  });

  // POST /tenant/pbx/test — testar a ligação (auth + listar extensões)
  fastify.post("/test", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const t = await loadTenant(tenantId);
    if (t.plan.productType !== "CRM_BYO_PBX") {
      return reply.status(403).send({ error: "O plano actual não permite configurar um PBX próprio" });
    }
    if (!t.pbxBaseUrl || !t.pbxClientId || !t.pbxClientSecret) {
      return reply.status(400).send({ error: "Configure e guarde as credenciais do PBX antes de testar" });
    }

    // Reusa o resolver (constrói adaptador com as credenciais guardadas, desencriptadas)
    const adapter = await getTenantTelephony(fastify, tenantId);

    try {
      const health = await adapter.healthCheck();
      if (!health.ok) {
        await prisma.tenant.update({ where: { id: tenantId }, data: { pbxConnected: false } });
        return reply.status(502).send({ ok: false, error: health.details ?? "Falha na ligação" });
      }
      const extensions = await adapter.listExtensions();
      await prisma.tenant.update({ where: { id: tenantId }, data: { pbxConnected: true } });
      return { ok: true, extensionsCount: extensions.length, extensions };
    } catch (err) {
      fastify.log.warn({ err }, "tenant.pbx.test_failed");
      await prisma.tenant.update({ where: { id: tenantId }, data: { pbxConnected: false } });
      return reply.status(502).send({ ok: false, error: "Não foi possível ligar ao PBX. Verifica as credenciais e a allowlist de IP." });
    }
  });
};
