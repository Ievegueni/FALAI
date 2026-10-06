import fp from "fastify-plugin";
import { IncomingCallHub } from "../services/incomingCalls.service.js";

declare module "fastify" {
  interface FastifyInstance {
    incomingCalls: IncomingCallHub;
    /** Mesmo hub, indexado por inboxId:token: stream SSE do visitante do widget. */
    widgetHub: IncomingCallHub;
  }
}

/**
 * Regista o hub de "screen pop" (chamadas a entrar → push SSE para o CRM).
 * As duas fontes de eventos (WebSocket/webhook do Yeastar partilhado e webhook
 * PBX por tenant) alimentam este hub através de `fastify.incomingCalls`.
 */
export default fp(async (fastify) => {
  fastify.decorate("incomingCalls", new IncomingCallHub());
  fastify.decorate("widgetHub", new IncomingCallHub());
});
