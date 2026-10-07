import type { FastifyPluginAsync } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@falai/db";

/**
 * Webhook de delivery report do gateway Futurix.
 *
 * A Futurix faz POST a este URL sempre que o estado de uma mensagem muda
 * (submitted → delivered / failed / expired). O `message_id` é o id que
 * devolvemos no envio (guardado em SmsMessage.providerMsgId), pelo que um único
 * endpoint global resolve o tenant sem precisar de token.
 *
 * Autenticação: se FUTURIX_SMS_WEBHOOK_SECRET estiver definido (SystemSetting
 * ou .env), o URL configurado na Futurix tem de levar ?token=<segredo>; sem
 * ele, aceita-se como antes e fica um aviso no arranque.
 *
 * Deve responder sempre 2xx (o corpo é ignorado pela Futurix).
 */

interface DeliveryReport {
  event?: string;
  message_id?: string;
  smsc_message_id?: string | null;
  status?: string; // submitted | delivered | failed | expired
  destination?: string | null;
  sender_id?: string | null;
  error_code?: string | null;
  timestamp?: string;
}

function mapStatus(status: string | undefined): "SENT" | "DELIVERED" | "FAILED" | null {
  switch ((status ?? "").toLowerCase()) {
    case "submitted":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "failed":
    case "expired":
      return "FAILED";
    default:
      return null;
  }
}

/** Comparação em tempo constante do ?token= com o segredo. Sem segredo configurado, aceita. */
export function isAuthorizedSmsWebhook(secret: string, token: unknown): boolean {
  if (!secret) return true;
  if (typeof token !== "string") return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const smsWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  const secret = fastify.providerConfig.futurix.webhookSecret;
  if (!secret) {
    fastify.log.warn("sms.webhook.no_secret — /webhooks/sms aceita pedidos sem autenticação; definir FUTURIX_SMS_WEBHOOK_SECRET");
  }

  fastify.post<{ Body: DeliveryReport; Querystring: { token?: string } }>("/", async (request, reply) => {
    if (!isAuthorizedSmsWebhook(secret, request.query?.token)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
    const source = request.headers["x-webhook-source"];
    const payload = request.body ?? {};
    fastify.log.info({ source, event: payload.event, status: payload.status, msgId: payload.message_id }, "sms.webhook.received");

    const messageId = payload.message_id;
    const newStatus = mapStatus(payload.status);
    if (!messageId || !newStatus) {
      // Nada a fazer, mas confirma recepção para a Futurix não repetir.
      return reply.status(200).send({ ok: true });
    }

    const msg = await prisma.smsMessage.findFirst({
      where: { providerMsgId: messageId },
      select: { id: true, status: true },
    });
    if (!msg) {
      fastify.log.warn({ messageId }, "sms.webhook.unknown_message");
      return reply.status(200).send({ ok: true });
    }

    // DELIVERED e FAILED são finais: eventos repetidos ou fora de ordem não os
    // regridem nem trocam um pelo outro (updateMany condicional = idempotente).
    await prisma.smsMessage.updateMany({
      where: { id: msg.id, status: { in: newStatus === "SENT" ? ["QUEUED", "SENDING"] : ["QUEUED", "SENDING", "SENT"] } },
      data: {
        status: newStatus,
        ...(newStatus === "FAILED" && payload.error_code ? { failReason: `Futurix: ${payload.error_code}` } : {}),
      },
    });

    return reply.status(200).send({ ok: true });
  });
};
