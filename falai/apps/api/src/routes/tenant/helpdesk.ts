import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@falai/db";
import { config } from "../../config.js";
import { encryptSecret } from "../../services/crypto.service.js";
import { normalizeFdDomain } from "../../services/helpdesk/freshdesk.js";
import { FRESHDESK, clientFor, enqueuePull, forgetDirectory, reconcile } from "../../services/helpdesk/sync.js";
import { isConfigAdmin, isOpsManager, requireConfigAdmin } from "../../services/userScope.js";

/**
 * Ligação ao helpdesk externo do cliente (Freshdesk) — ver services/helpdesk/.
 * Configurar é técnico (OWNER/ADMIN); o gestor vê o estado.
 */

const saveSchema = z.object({
  domain: z.string().trim().min(3).max(120),
  apiKey: z.string().trim().min(8).max(200).optional(), // vazio = manter a que está
  enabled: z.boolean(),
  ticketOnCall: z.enum(["NEVER", "AGENT_CHOICE", "ALWAYS"]).default("AGENT_CHOICE"),
  includeRecordingLink: z.boolean().default(false),
});

const publicApi = (request: FastifyRequest) =>
  (process.env["PUBLIC_API_URL"] ?? `${request.protocol}://${request.headers.host ?? "localhost:3000"}`).replace(/\/$/, "");

export const tenantHelpdeskRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];
  const production = config.NODE_ENV === "production";

  fastify.get("/tenant/helpdesk", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const c = await prisma.helpdeskConnection.findUnique({ where: { tenantId } });
    if (!c) return { configured: false, canEdit: isConfigAdmin(role) };
    return {
      configured: true,
      canEdit: isConfigAdmin(role),
      provider: c.provider,
      enabled: c.enabled,
      domain: c.domain,
      apiKeySet: true,
      ticketOnCall: c.ticketOnCall,
      includeRecordingLink: c.includeRecordingLink,
      webhookUrl: `${publicApi(request)}/webhooks/helpdesk/${c.webhookToken}`,
      webhookBody: '{"ticket_id": "{{ticket.id}}"}',
      lastSyncAt: c.lastSyncAt,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt,
    };
  });

  fastify.put("/tenant/helpdesk", { preHandler: [...preHandler, requireConfigAdmin] }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const body = saveSchema.parse(request.body);
    const domain = normalizeFdDomain(body.domain, production);
    if (!domain) return reply.status(400).send({ error: "Domínio inválido — use o endereço da conta, ex.: empresa.freshdesk.com" });
    const existing = await prisma.helpdeskConnection.findUnique({ where: { tenantId } });
    if (!existing && !body.apiKey) return reply.status(400).send({ error: "Indique a API key do Freshdesk" });
    const apiKey = body.apiKey ? encryptSecret(body.apiKey) : existing!.apiKey;

    // Ligar só com credenciais que funcionam — senão a fila enche-se de falhas.
    if (body.enabled) {
      try {
        await clientFor({ domain, apiKey }).me();
      } catch (err) {
        return reply.status(400).send({ error: `Não foi possível ligar ao Freshdesk: ${(err as Error).message}` });
      }
    }
    await prisma.helpdeskConnection.upsert({
      where: { tenantId },
      create: { tenantId, provider: FRESHDESK, domain, apiKey, enabled: body.enabled, ticketOnCall: body.ticketOnCall, includeRecordingLink: body.includeRecordingLink, webhookToken: randomBytes(24).toString("base64url") },
      update: { domain, apiKey, enabled: body.enabled, ticketOnCall: body.ticketOnCall, includeRecordingLink: body.includeRecordingLink, lastError: null, lastErrorAt: null },
    });
    forgetDirectory(tenantId);
    await fastify.audit({
      actorType: "TENANT_USER", actorId: sub, tenantId, action: "tenant.helpdesk.updated", targetType: "Tenant", targetId: tenantId,
      after: { domain, enabled: body.enabled, ticketOnCall: body.ticketOnCall, includeRecordingLink: body.includeRecordingLink, apiKeyChanged: !!body.apiKey },
      ip: request.ip,
    });
    return { ok: true };
  });

  // Teste de ligação com o que está guardado
  fastify.post("/tenant/helpdesk/test", { preHandler: [...preHandler, requireConfigAdmin] }, async (request, reply) => {
    const c = await prisma.helpdeskConnection.findUnique({ where: { tenantId: request.tenantUser!.tenantId } });
    if (!c) return reply.status(404).send({ error: "Sem ligação configurada" });
    try {
      const me = await clientFor(c).me();
      return { ok: true, agent: me.contact?.name ?? null, email: me.contact?.email ?? null };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Sincronizar já (sem esperar pelos 5 minutos)
  fastify.post("/tenant/helpdesk/sync", { preHandler: [...preHandler, requireConfigAdmin] }, async (request, reply) => {
    const c = await prisma.helpdeskConnection.findFirst({ where: { tenantId: request.tenantUser!.tenantId, enabled: true } });
    if (!c) return reply.status(409).send({ error: "A ligação não está activa" });
    try {
      return { ok: true, ...(await reconcile(c, fastify.log)) };
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
};

/**
 * Webhook que o helpdesk do cliente chama quando um ticket muda (regra de
 * automação no Freshdesk). O token no URL identifica o cliente; o corpo só
 * precisa do id do ticket — o estado vai-se buscar à API, não se confia no corpo.
 */
export const helpdeskWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { token: string } }>(
    "/webhooks/helpdesk/:token",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const c = await prisma.helpdeskConnection.findUnique({ where: { webhookToken: request.params.token }, select: { tenantId: true, enabled: true } });
      if (!c?.enabled) return reply.status(404).send({ error: "Not found" });
      const b = (request.body ?? {}) as { ticket_id?: unknown; id?: unknown; freshdesk_webhook?: { ticket_id?: unknown } };
      const id = String(b.ticket_id ?? b.freshdesk_webhook?.ticket_id ?? b.id ?? "").replace(/\D/g, "");
      if (!id) return reply.status(400).send({ error: "ticket_id em falta" });
      await enqueuePull(c.tenantId, id);
      return reply.status(202).send({ ok: true });
    }
  );
};

