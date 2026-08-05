import fp from "fastify-plugin";
import type { CallEvent } from "@falai/shared";

type EventHandler = (event: CallEvent) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    onCallEvent: (handler: EventHandler) => void;
  }
}

/**
 * Multiplexor de eventos Yeastar — permite que vários serviços (CallEngine,
 * OtpCallService, etc.) recebam eventos sem sobrescrever o subscribeToEvents.
 * Deve ser registado ANTES de qualquer plugin que consuma eventos.
 */
export default fp(async (fastify) => {
  const handlers: EventHandler[] = [];

  fastify.decorate("onCallEvent", (handler: EventHandler) => {
    handlers.push(handler);
  });

  await fastify.telephony.subscribeToEvents(async (event) => {
    await Promise.all(
      handlers.map((h) =>
        h(event).catch((err) => fastify.log.error({ err, event }, "eventBus.handler_error"))
      )
    );
  });
});
