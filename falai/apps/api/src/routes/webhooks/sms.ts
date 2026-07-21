import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";

/**
 * Webhook de delivery report do gateway Futurix.
 *
 * A Futurix faz POST a este URL sempre que o estado de uma mensagem muda
 * (submitted → delivered / failed / expired). O `message_id` é o id que
 * devolvemos no envio (guardado em SmsMessage.providerMsgId), pelo que um único
 * endpoint global resolve o tenant sem precisar de token.
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

export const smsWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: DeliveryReport }>("/", async (request, reply) => {
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

    // Não regride um DELIVERED para SENT se chegarem eventos fora de ordem.
    if (msg.status === "DELIVERED" && newStatus === "SENT") {
      return reply.status(200).send({ ok: true });
    }

    await prisma.smsMessage.update({
      where: { id: msg.id },
      data: {
        status: newStatus,
        ...(newStatus === "FAILED" && payload.error_code ? { failReason: `Futurix: ${payload.error_code}` } : {}),
      },
    });

    return reply.status(200).send({ ok: true });
  });
};
