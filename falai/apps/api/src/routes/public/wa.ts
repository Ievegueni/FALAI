import type { FastifyPluginAsync } from "fastify";
import { tenantHasFeature } from "../../services/features.js";
import { resolveActive } from "../../services/waPool.service.js";

/**
 * Botão "Falar connosco pelo WhatsApp" do site do cliente:
 * GET /public/wa/:tenantId[?text=Olá] → 302 para wa.me do número em serviço
 * no pool Active/Standby (ver docs/WHATSAPP-ACTIVE-STANDBY.md). Só lê o
 * estado — quem troca de número é o health check, nunca o clique.
 */
export const publicWaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { tenantId: string }; Querystring: { text?: string } }>("/:tenantId", async (request, reply) => {
    const { tenantId } = request.params;
    // 302 + no-store: o browser não pode guardar o destino, senão ficava preso ao número antigo.
    reply.header("Cache-Control", "no-store");
    if (!(await tenantHasFeature(tenantId, "inbox"))) return reply.status(404).send("not found");

    const active = await resolveActive(fastify, tenantId);
    const digits = String((active?.config as { displayPhone?: string } | undefined)?.displayPhone ?? "").replace(/\D/g, "");
    if (!digits) {
      return reply
        .status(503)
        .type("text/html; charset=utf-8")
        .send('<!doctype html><meta name="viewport" content="width=device-width"><p style="font-family:sans-serif;padding:2rem">O atendimento por WhatsApp está indisponível de momento. Por favor tente mais tarde ou use outro contacto do site.</p>');
    }

    const text = request.query.text?.slice(0, 500);
    return reply.redirect(`https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`, 302);
  });
};
