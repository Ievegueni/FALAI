import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { recordWebphoneCall } from "../../services/webphoneCdr.service.js";

/**
 * CDR das chamadas marcadas no telefone (webphone/hardphone).
 *
 * Quem chama isto é o próprio dialplan do Asterisk, no hangup handler do
 * contexto [from-internal] — ver infra/asterisk/templates/extensions.conf.template.
 * É a única forma de a API saber destas chamadas: o softphone fala directamente
 * com o Asterisk e nunca passa por aqui.
 *
 * Autenticação por segredo partilhado (ASTERISK_CDR_SECRET). Não é uma rota
 * pública: só o contentor do Asterisk lhe chega.
 */
const cdrSchema = z.object({
  endpoint: z.string().min(1),
  to: z.string().min(1),
  billsec: z.coerce.number().int().min(0).max(86_400),
  disposition: z.string().default(""),
  uniqueid: z.string().min(1),
});

export const asteriskWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  const secret = process.env["ASTERISK_CDR_SECRET"] ?? "";

  // A função CURL() do dialplan envia form-urlencoded, que o Fastify não
  // percebe de origem (só JSON). Sem isto o corpo chegava vazio.
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  fastify.post("/cdr", async (request, reply) => {
    if (!secret || request.headers["x-falai-cdr-secret"] !== secret) {
      fastify.log.warn({ ip: request.ip }, "asterisk.cdr.unauthorized");
      return reply.status(401).send({ error: "unauthorized" });
    }

    const parsed = cdrSchema.safeParse(request.body);
    if (!parsed.success) {
      fastify.log.warn({ body: request.body }, "asterisk.cdr.invalid_payload");
      // 200 na mesma: o dialplan não tem como reagir a um erro e uma chamada
      // já terminada não se repete.
      return reply.status(200).send({ ok: false });
    }

    // Não segurar o dialplan à espera da base de dados: a chamada já acabou.
    void recordWebphoneCall(parsed.data, fastify.log).catch((err) =>
      fastify.log.error({ err }, "asterisk.cdr.record_failed")
    );

    return { ok: true };
  });
};
