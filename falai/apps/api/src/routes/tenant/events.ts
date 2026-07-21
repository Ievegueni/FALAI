import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import type { TenantJwtPayload } from "../../plugins/auth.js";

const KEEPALIVE_MS = 25_000;

/**
 * Stream SSE de eventos em tempo real para o CRM (por agora: chamadas a entrar).
 *
 * O EventSource do browser não envia o header Authorization, por isso o token
 * viaja como query param `?token=`. Validamos o JWT manualmente e confirmamos
 * que o tenant continua activo antes de abrir o stream.
 */
export const tenantEventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { token?: string } }>("/tenant/events/stream", async (request, reply) => {
    const token = request.query.token;
    if (!token) return reply.status(401).send({ error: "Token em falta" });

    let payload: TenantJwtPayload;
    try {
      const decoded = fastify.jwt.verify(token) as TenantJwtPayload;
      if (decoded.type !== "tenant") return reply.status(401).send({ error: "Sessão inválida" });
      payload = decoded;
    } catch {
      return reply.status(401).send({ error: "Não autenticado" });
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: payload.tenantId },
      select: { status: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt || tenant.status === "SUSPENDED" || tenant.status === "CLOSED") {
      return reply.status(403).send({ error: "Conta inactiva ou suspensa" });
    }

    // Abre o stream SSE. hijack() passa o controlo do socket para nós — o que
    // significa que os headers de CORS do @fastify/cors não são aplicados, por
    // isso reflectimos a origem manualmente (o EventSource é cross-origin em dev).
    const origin = request.headers.origin;
    const corsHeaders: Record<string, string> = origin
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
      : {};

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // desliga o buffering do nginx
      ...corsHeaders,
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const unsubscribe = fastify.incomingCalls.subscribe(payload.tenantId, reply);

    // Comentário de keep-alive para atravessar proxies/timeouts.
    const keepalive = setInterval(() => {
      try {
        reply.raw.write(`: keepalive\n\n`);
      } catch {
        // socket fechado
      }
    }, KEEPALIVE_MS);

    const cleanup = () => {
      clearInterval(keepalive);
      unsubscribe();
    };
    request.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  });
};
