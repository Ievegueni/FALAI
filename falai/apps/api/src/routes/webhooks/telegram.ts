import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@falai/db";
import { ingestInbound } from "../../services/textChannels.service.js";
import { tenantHasFeature } from "../../services/features.js";

interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    text?: string;
    caption?: string;
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Webhook do bot de Telegram de um inbox. O setWebhook (feito ao guardar o
 * inbox) regista o `secret_token`, que o Telegram devolve em cada pedido no
 * header X-Telegram-Bot-Api-Secret-Token.
 */
export const telegramWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { inboxId: string }; Body: TelegramUpdate }>("/:inboxId", async (request, reply) => {
    const inbox = await prisma.inbox.findFirst({
      where: { id: request.params.inboxId, channel: "TELEGRAM", enabled: true, deletedAt: null },
    });
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    if (!inbox || typeof secret !== "string" || !safeEqual(secret, inbox.webhookSecret)) {
      return reply.status(401).send({ ok: false });
    }

    // Funcionalidade desligada: aceita (senão o Telegram reenvia) e ignora.
    if (!(await tenantHasFeature(inbox.tenantId, "inbox"))) return { ok: true };

    const m = request.body?.message;
    // Só conversas privadas; grupos e edições ficam de fora até alguém pedir.
    if (m && m.chat.type === "private" && (m.text ?? m.caption)) {
      const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username;
      void ingestInbound(fastify, inbox, {
        externalRef: String(m.chat.id),
        externalId: String(m.message_id),
        text: (m.text ?? m.caption)!,
        identity: { telegramId: String(m.from?.id ?? m.chat.id), ...(name && { name }) },
      }).catch((err) => fastify.log.error({ err, inboxId: inbox.id }, "telegram.ingest_failed"));
    }
    return { ok: true };
  });
};
