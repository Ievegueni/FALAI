import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sendSms,
  SmsDisabledError,
  SmsNotConfiguredError,
  InsufficientBalanceError,
} from "../../services/sms.service.js";

const bodySchema = z.object({
  to: z.string().min(5, "Número de destino obrigatório"),
  body: z.string().min(1, "Mensagem vazia").max(1000),
});

export async function v1SmsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/sms/send — envia um SMS.
   * Requer scope: sms:send. Cobra por segmento ao preço configurado para o cliente.
   */
  fastify.post("/v1/sms/send", { preHandler: [fastify.verifyScope("sms:send")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    }
    try {
      const sent = await sendSms(fastify, tenantId, { to: parsed.data.to, body: parsed.data.body });
      if (sent.status === "FAILED") return reply.status(502).send({ error: "Falha no envio", sms: sent });
      return reply.status(202).send({ id: sent.id, status: sent.status, segments: sent.segments, costCents: sent.costCents });
    } catch (err) {
      if (err instanceof SmsDisabledError) return reply.status(403).send({ error: err.message });
      if (err instanceof SmsNotConfiguredError) return reply.status(422).send({ error: err.message });
      if (err instanceof InsufficientBalanceError) return reply.status(402).send({ error: err.message });
      throw err;
    }
  });
}
