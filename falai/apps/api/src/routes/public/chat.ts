import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma, type Inbox } from "@falai/db";
import { z } from "zod";
import { tenantHasFeature } from "../../services/features.js";
import { ingestInbound, publicMessage, resolveContact, widgetKey } from "../../services/textChannels.service.js";

/**
 * Widget de chat para o site do cliente. Sem login: a sessão é um token
 * aleatório que o widget guarda em localStorage e que é o externalRef da
 * conversa — quem não tem o token não lê nem escreve nela.
 *
 * O widget envia POST com Content-Type text/plain (pedido "simples"), para não
 * haver preflight CORS a partir de sites de terceiros.
 */

// Lido no primeiro pedido e não no arranque: se o ficheiro faltar (cwd
// diferente de apps/api, deploy sem public/), só o widget falha — a API arranca.
let widgetJs: string | null = null;
function loadWidgetJs(): string | null {
  if (widgetJs === null) {
    try {
      widgetJs = readFileSync(path.resolve(process.env["WIDGET_JS_PATH"] ?? "public/widget.js"), "utf8");
    } catch {
      return null;
    }
  }
  return widgetJs;
}
const KEEPALIVE_MS = 25_000;

const messageSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{48}$/).optional(),
  text: z.string().trim().min(1).max(2000),
  name: z.string().max(80).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
});

const tokenQuery = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/) });

/** Valida a origem contra o inbox e devolve os headers CORS. Null = recusado. */
function corsFor(inbox: Inbox, request: FastifyRequest): Record<string, string> | null {
  const origin = request.headers.origin;
  const allowed = ((inbox.config as { allowedOrigins?: string[] }).allowedOrigins ?? []).map((o) => o.replace(/\/$/, ""));
  // Sem lista configurada aceita qualquer site (útil para testar); com lista, só esses.
  if (allowed.length > 0 && (!origin || !allowed.includes(origin))) return null;
  return origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
}

async function loadInbox(request: FastifyRequest<{ Params: { inboxId: string } }>, reply: FastifyReply) {
  const inbox = await prisma.inbox.findFirst({
    where: { id: request.params.inboxId, channel: "WEBCHAT", enabled: true, deletedAt: null },
  });
  if (!inbox || !(await tenantHasFeature(inbox.tenantId, "inbox"))) {
    reply.status(404).send({ error: "Chat indisponível" });
    return null;
  }
  const cors = corsFor(inbox, request);
  if (!cors) {
    reply.status(403).send({ error: "Origem não autorizada" });
    return null;
  }
  reply.headers(cors);
  return { inbox, cors };
}

export const publicChatRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/widget.js", async (_request, reply) => {
    const js = loadWidgetJs();
    if (!js) {
      fastify.log.error("widget.js não encontrado — definir WIDGET_JS_PATH ou arrancar a API em apps/api");
      return reply.status(404).send("// widget indisponível");
    }
    return reply.type("application/javascript; charset=utf-8").header("Cache-Control", "public, max-age=300").send(js);
  });

  fastify.get<{ Params: { inboxId: string } }>("/:inboxId/config", async (request, reply) => {
    const ctx = await loadInbox(request, reply);
    if (!ctx) return;
    const c = ctx.inbox.config as { title?: string; welcome?: string; color?: string };
    return { title: c.title ?? ctx.inbox.name, welcome: c.welcome ?? null, color: c.color ?? "#2563eb" };
  });

  fastify.get<{ Params: { inboxId: string } }>("/:inboxId/history", async (request, reply) => {
    const ctx = await loadInbox(request, reply);
    if (!ctx) return;
    const { token } = tokenQuery.parse(request.query);
    const conv = await prisma.conversation.findFirst({
      where: { inboxId: ctx.inbox.id, externalRef: token },
      orderBy: { createdAt: "desc" },
      include: { messages: { where: { role: { not: "SYSTEM" } }, orderBy: { seq: "asc" }, take: 100 } },
    });
    return { data: (conv?.messages ?? []).map(publicMessage) };
  });

  fastify.post<{ Params: { inboxId: string } }>(
    "/:inboxId/message",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = await loadInbox(request, reply);
      if (!ctx) return;
      const raw = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body;
      const body = messageSchema.parse(raw);
      const token = body.token ?? randomBytes(24).toString("hex");
      const identity = {
        ...(body.name && { name: body.name }),
        ...(body.email && { email: body.email }),
        ...(body.phone && { phone: body.phone }),
      };

      const conv = await ingestInbound(fastify, ctx.inbox, { externalRef: token, text: body.text, identity });
      // Visitante anónimo que deu email/telefone: funde com o Contact.
      if (!conv.contactId && (body.email || body.phone)) {
        const contactId = await resolveContact(ctx.inbox.tenantId, identity);
        if (contactId) await prisma.conversation.update({ where: { id: conv.id }, data: { contactId } });
      }
      return reply.status(201).send({ token });
    }
  );

  fastify.get<{ Params: { inboxId: string } }>("/:inboxId/stream", async (request, reply) => {
    const ctx = await loadInbox(request, reply);
    if (!ctx) return;
    const { token } = tokenQuery.parse(request.query);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...ctx.cors,
    });
    reply.raw.write(`event: ready\ndata: {}\n\n`);
    const unsubscribe = fastify.widgetHub.subscribe(widgetKey(ctx.inbox.id, token), reply);
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
