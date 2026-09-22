import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { prisma, type Prisma } from "@falai/db";
import { z } from "zod";
import { appendMessage, broadcastConversation, deliver } from "../../services/textChannels.service.js";
import { UPLOADS_DIR } from "../../services/email.service.js";
import { emitWebhookAsync } from "../../services/webhookEmitter.service.js";

const listQuery = z.object({
  status: z.enum(["OPEN", "PENDING", "RESOLVED"]).optional(),
  inboxId: z.string().optional(),
  assignee: z.string().optional(), // "me" | "none" | TenantUser.id
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(), // paginação por lastMessageAt
});

const replySchema = z.object({
  text: z.string().min(1).max(4000),
  /** Nota interna: fica só no CRM, não sai para o cliente. */
  private: z.boolean().optional(),
});

const patchSchema = z.object({
  status: z.enum(["OPEN", "PENDING", "RESOLVED"]).optional(),
  mode: z.enum(["AI", "HUMAN"]).optional(),
  assigneeId: z.string().nullable().optional(),
  /** Bloqueio optimista: o updatedAt que o operador tinha no ecrã. */
  updatedAt: z.string().datetime(),
});

const cannedSchema = z.object({
  shortcut: z.string().min(1).max(40).regex(/^[\w-]+$/, "Só letras, números, - e _"),
  text: z.string().min(1).max(4000),
});

const conversationInclude = {
  inbox: { select: { id: true, name: true, channel: true } },
  contact: { select: { id: true, name: true, phone: true, email: true, telegramId: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude;

export const tenantConversationsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/conversations
  fastify.get("/tenant/conversations", { preHandler }, async (request) => {
    const { tenantId, sub } = request.tenantUser!;
    const q = listQuery.parse(request.query);
    const where: Prisma.ConversationWhereInput = {
      tenantId,
      ...(q.status && { status: q.status }),
      ...(q.inboxId && { inboxId: q.inboxId }),
      ...(q.assignee === "me" && { assigneeId: sub }),
      ...(q.assignee === "none" && { assigneeId: null }),
      ...(q.assignee && !["me", "none"].includes(q.assignee) && { assigneeId: q.assignee }),
      ...(q.before && { lastMessageAt: { lt: new Date(q.before) } }),
    };
    const rows = await prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: q.limit,
      include: {
        ...conversationInclude,
        messages: { orderBy: { seq: "desc" }, take: 1, select: { role: true, text: true, createdAt: true } },
      },
    });
    return {
      data: rows.map(({ messages, ...c }) => ({ ...c, lastMessage: messages[0] ?? null })),
    };
  });

  // GET /tenant/conversations/:id — conversa + mensagens
  fastify.get<{ Params: { id: string } }>("/tenant/conversations/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const conv = await prisma.conversation.findFirst({
      where: { id: request.params.id, tenantId },
      include: {
        ...conversationInclude,
        messages: { orderBy: { seq: "asc" }, include: { conversation: false } },
      },
    });
    if (!conv) return reply.status(404).send({ error: "Conversa não encontrada" });
    const authorIds = [...new Set(conv.messages.map((m) => m.authorId).filter((x): x is string => !!x))];
    const authors = await prisma.tenantUser.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } });
    return { ...conv, authors };
  });

  // POST /tenant/conversations/:id/messages — resposta do operador (ou nota interna)
  fastify.post<{ Params: { id: string } }>("/tenant/conversations/:id/messages", { preHandler }, async (request, reply) => {
    const { tenantId, sub, role } = request.tenantUser!;
    if (role === "VIEWER") return reply.status(403).send({ error: "Sem permissão" });
    const body = replySchema.parse(request.body);
    const conv = await prisma.conversation.findFirst({ where: { id: request.params.id, tenantId }, include: { inbox: true } });
    if (!conv) return reply.status(404).send({ error: "Conversa não encontrada" });

    if (body.private) {
      const note = await appendMessage(fastify, conv, { role: "SYSTEM", text: body.text, authorId: sub });
      return reply.status(201).send(note);
    }

    // Responder é assumir: a IA cala-se nesta conversa até ser devolvida.
    if (conv.mode === "AI" || !conv.assigneeId || conv.status !== "OPEN") {
      const updated = await prisma.conversation.update({
        where: { id: conv.id },
        data: { mode: "HUMAN", assigneeId: conv.assigneeId ?? sub, status: "OPEN" },
      });
      broadcastConversation(fastify, tenantId, conv.id, { mode: updated.mode, assigneeId: updated.assigneeId, status: updated.status, updatedAt: updated.updatedAt });
    }

    const msg = await appendMessage(fastify, conv, { role: "AGENT", text: body.text, authorId: sub });
    await deliver(fastify, conv.inbox, conv, body.text, msg.id);
    return reply.status(201).send(msg);
  });

  // PATCH /tenant/conversations/:id — estado, modo (assumir/devolver à IA), atribuição
  fastify.patch<{ Params: { id: string } }>("/tenant/conversations/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (role === "VIEWER") return reply.status(403).send({ error: "Sem permissão" });
    const body = patchSchema.parse(request.body);

    if (body.assigneeId && !(await prisma.tenantUser.findFirst({ where: { id: body.assigneeId, tenantId } }))) {
      return reply.status(400).send({ error: "Utilizador não encontrado" });
    }

    const data: Prisma.ConversationUncheckedUpdateManyInput = {
      ...(body.status && { status: body.status }),
      ...(body.mode && { mode: body.mode }),
      ...(body.assigneeId !== undefined && { assigneeId: body.assigneeId }),
    };
    // Bloqueio optimista: dois operadores na mesma conversa — o segundo recebe 409.
    const { count } = await prisma.conversation.updateMany({
      where: { id: request.params.id, tenantId, updatedAt: new Date(body.updatedAt) },
      data,
    });
    const conv = await prisma.conversation.findFirst({ where: { id: request.params.id, tenantId }, include: conversationInclude });
    if (!conv) return reply.status(404).send({ error: "Conversa não encontrada" });
    if (count === 0) return reply.status(409).send({ error: "A conversa foi alterada por outra pessoa", conversation: conv });

    broadcastConversation(fastify, tenantId, conv.id, {
      status: conv.status, mode: conv.mode, assigneeId: conv.assigneeId, assignee: conv.assignee, updatedAt: conv.updatedAt,
    });
    if (body.status === "RESOLVED") {
      emitWebhookAsync({ tenantId, event: "conversation.resolved", payload: { conversationId: conv.id, channel: conv.inbox.channel, contactId: conv.contactId } });
    }
    return conv;
  });

  // GET /tenant/conversations/attachments/:file — anexos em disco, só do próprio tenant
  fastify.get<{ Params: { file: string } }>("/tenant/conversations/attachments/:file", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const file = path.basename(request.params.file);
    const full = path.join(UPLOADS_DIR, tenantId, file);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return reply.status(404).send({ error: "Anexo não encontrado" });
    return reply
      .header("Content-Length", info.size)
      .header("Content-Disposition", `attachment; filename="${file}"`)
      .type("application/octet-stream")
      .send(createReadStream(full));
  });

  // ── Respostas rápidas ─────────────────────────────────────────────────────
  fastify.get("/tenant/canned-responses", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    return { data: await prisma.cannedResponse.findMany({ where: { tenantId }, orderBy: { shortcut: "asc" } }) };
  });

  fastify.post("/tenant/canned-responses", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (role === "VIEWER") return reply.status(403).send({ error: "Sem permissão" });
    const body = cannedSchema.parse(request.body);
    const row = await prisma.cannedResponse
      .create({ data: { tenantId, ...body } })
      .catch(() => null);
    if (!row) return reply.status(409).send({ error: "Já existe uma resposta com esse atalho" });
    return reply.status(201).send(row);
  });

  fastify.delete<{ Params: { id: string } }>("/tenant/canned-responses/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (role === "VIEWER") return reply.status(403).send({ error: "Sem permissão" });
    await prisma.cannedResponse.deleteMany({ where: { id: request.params.id, tenantId } });
    return reply.status(204).send();
  });
};
