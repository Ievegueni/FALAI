import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { prisma, type Inbox, type Prisma } from "@falai/db";
import { z } from "zod";
import { encryptSecret } from "../../services/crypto.service.js";
import { telegramApi, inboxSecret } from "../../services/textChannels.service.js";

/**
 * Inboxes dos canais de texto (Telegram, widget web, email).
 * Segredos no `config` (botToken, imapPass, smtpPass) vão cifrados e nunca
 * voltam ao cliente — só um indicador de que estão definidos.
 */

const SECRET_KEYS = ["botToken", "imapPass", "smtpPass"] as const;

const configSchema = z
  .object({
    // TELEGRAM
    botToken: z.string().min(20).optional(),
    // WEBCHAT
    allowedOrigins: z.array(z.string().url()).optional(),
    title: z.string().max(60).optional(),
    welcome: z.string().max(300).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    // EMAIL
    imapHost: z.string().optional(),
    imapPort: z.number().int().optional(),
    imapUser: z.string().optional(),
    imapPass: z.string().optional(),
    smtpHost: z.string().optional(),
    smtpPort: z.number().int().optional(),
    smtpUser: z.string().optional(),
    smtpPass: z.string().optional(),
    fromAddress: z.string().email().optional(),
    replyTo: z.string().email().optional(),
  })
  .strict();

const createSchema = z.object({
  channel: z.enum(["WEBCHAT", "EMAIL", "TELEGRAM"]),
  name: z.string().min(1).max(80),
  agentId: z.string().min(1).nullable().optional(),
  autoReply: z.boolean().optional(),
  config: configSchema.default({}),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  agentId: z.string().min(1).nullable().optional(),
  autoReply: z.boolean().optional(),
  enabled: z.boolean().optional(),
  config: configSchema.optional(),
});

function publicApiUrl(request: FastifyRequest): string {
  const env = process.env["PUBLIC_API_URL"];
  if (env) return env.replace(/\/$/, "");
  return `${request.protocol}://${request.headers.host ?? "localhost:3000"}`;
}

/** Junta a config nova à existente, cifrando segredos. Segredo vazio/omisso mantém o actual. */
function mergeConfig(current: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if ((SECRET_KEYS as readonly string[]).includes(k)) {
      if (typeof v === "string" && v) out[k] = encryptSecret(v);
    } else out[k] = v;
  }
  return out;
}

function serialize(inbox: Inbox, request: FastifyRequest) {
  const config = { ...(inbox.config as Record<string, unknown>) };
  const secretsSet: Record<string, boolean> = {};
  for (const k of SECRET_KEYS) {
    secretsSet[k] = !!config[k];
    delete config[k];
  }
  const base = publicApiUrl(request);
  return {
    id: inbox.id,
    channel: inbox.channel,
    name: inbox.name,
    agentId: inbox.agentId,
    autoReply: inbox.autoReply,
    enabled: inbox.enabled,
    config,
    secretsSet,
    createdAt: inbox.createdAt,
    ...(inbox.channel === "WEBCHAT" && {
      snippet: `<script src="${base}/public/chat/widget.js" data-inbox="${inbox.id}" async></script>`,
    }),
  };
}

/** Valida o token do bot e aponta o webhook dele para nós. */
async function connectTelegram(inbox: Inbox, botToken: string, request: FastifyRequest) {
  const me = (await telegramApi(botToken, "getMe", {})) as { username: string };
  await telegramApi(botToken, "setWebhook", {
    url: `${publicApiUrl(request)}/webhooks/telegram/${inbox.id}`,
    secret_token: inbox.webhookSecret,
    allowed_updates: ["message"],
  });
  return me.username;
}

export const tenantInboxesRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];
  const isAdmin = (request: FastifyRequest) => ["OWNER", "ADMIN"].includes(request.tenantUser!.role);

  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const inboxes = await prisma.inbox.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: "asc" } });
    return { data: inboxes.map((i) => serialize(i, request)) };
  });

  fastify.post("/", { preHandler }, async (request, reply) => {
    if (!isAdmin(request)) return reply.status(403).send({ error: "Apenas OWNER ou ADMIN" });
    const { tenantId } = request.tenantUser!;
    const body = createSchema.parse(request.body);
    if (body.agentId && !(await prisma.agent.findFirst({ where: { id: body.agentId, tenantId, deletedAt: null } }))) {
      return reply.status(400).send({ error: "Agente não encontrado" });
    }
    if (body.channel === "TELEGRAM" && !body.config.botToken) {
      return reply.status(400).send({ error: "Token do bot obrigatório" });
    }

    let inbox = await prisma.inbox.create({
      data: {
        tenantId,
        channel: body.channel,
        name: body.name,
        agentId: body.agentId ?? null,
        autoReply: body.autoReply ?? true,
        config: mergeConfig({}, body.config) as Prisma.InputJsonValue,
        webhookSecret: randomBytes(24).toString("hex"),
      },
    });

    if (body.channel === "TELEGRAM") {
      try {
        const botUsername = await connectTelegram(inbox, body.config.botToken!, request);
        inbox = await prisma.inbox.update({
          where: { id: inbox.id },
          data: { config: { ...(inbox.config as object), botUsername } },
        });
      } catch (err) {
        await prisma.inbox.delete({ where: { id: inbox.id } });
        return reply.status(400).send({ error: `Telegram recusou o token: ${err instanceof Error ? err.message : err}` });
      }
    }

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      action: "inbox.create",
      targetType: "Inbox",
      targetId: inbox.id,
      after: { channel: inbox.channel, name: inbox.name },
      ip: request.ip,
    });
    return reply.status(201).send(serialize(inbox, request));
  });

  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    if (!isAdmin(request)) return reply.status(403).send({ error: "Apenas OWNER ou ADMIN" });
    const { tenantId } = request.tenantUser!;
    const body = updateSchema.parse(request.body);
    const current = await prisma.inbox.findFirst({ where: { id: request.params.id, tenantId, deletedAt: null } });
    if (!current) return reply.status(404).send({ error: "Inbox não encontrado" });
    if (body.agentId && !(await prisma.agent.findFirst({ where: { id: body.agentId, tenantId, deletedAt: null } }))) {
      return reply.status(400).send({ error: "Agente não encontrado" });
    }

    let config = body.config ? mergeConfig(current.config as Record<string, unknown>, body.config) : undefined;
    if (current.channel === "TELEGRAM" && body.config?.botToken) {
      try {
        const botUsername = await connectTelegram(current, body.config.botToken, request);
        config = { ...config, botUsername };
      } catch (err) {
        return reply.status(400).send({ error: `Telegram recusou o token: ${err instanceof Error ? err.message : err}` });
      }
    }

    const inbox = await prisma.inbox.update({
      where: { id: current.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.agentId !== undefined && { agentId: body.agentId }),
        ...(body.autoReply !== undefined && { autoReply: body.autoReply }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(config && { config: config as Prisma.InputJsonValue }),
      },
    });
    return serialize(inbox, request);
  });

  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    if (!isAdmin(request)) return reply.status(403).send({ error: "Apenas OWNER ou ADMIN" });
    const { tenantId } = request.tenantUser!;
    const inbox = await prisma.inbox.findFirst({ where: { id: request.params.id, tenantId, deletedAt: null } });
    if (!inbox) return reply.status(404).send({ error: "Inbox não encontrado" });
    if (inbox.channel === "TELEGRAM") {
      const token = inboxSecret(inbox, "botToken");
      if (token) await telegramApi(token, "deleteWebhook", {}).catch(() => {});
    }
    await prisma.inbox.update({ where: { id: inbox.id }, data: { deletedAt: new Date(), enabled: false } });
    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      action: "inbox.delete",
      targetType: "Inbox",
      targetId: inbox.id,
      ip: request.ip,
    });
    return reply.status(204).send();
  });
};
