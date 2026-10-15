import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { z } from "zod";
import { appendMessage, deliver } from "../../services/textChannels.service.js";

const listQuery = z.object({
  status: z.enum(["OPEN", "PENDING", "RESOLVED"]).optional(),
  inboxId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

const sendSchema = z.object({ text: z.string().min(1).max(4000) });

const select = {
  id: true, inboxId: true, contactId: true, status: true, mode: true, subject: true,
  lastMessageAt: true, createdAt: true,
  inbox: { select: { channel: true, name: true } },
} satisfies Prisma.ConversationSelect;

/** Conversas dos canais de texto na API pública. */
export async function v1ConversationsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/conversations", { preHandler: [fastify.verifyScope("conversations:read")] }, async (request) => {
    const tenantId = request.apiKey!.tenantId;
    const q = listQuery.parse(request.query);
    const data = await prisma.conversation.findMany({
      where: {
        tenantId,
        ...(q.status && { status: q.status }),
        ...(q.inboxId && { inboxId: q.inboxId }),
        ...(q.before && { lastMessageAt: { lt: new Date(q.before) } }),
      },
      orderBy: { lastMessageAt: "desc" },
      take: q.limit,
      select,
    });
    return { data };
  });

  fastify.get<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    { preHandler: [fastify.verifyScope("conversations:read")] },
    async (request, reply) => {
      const conv = await prisma.conversation.findFirst({
        where: { id: request.params.id, tenantId: request.apiKey!.tenantId },
        select: {
          ...select,
          messages: {
            where: { role: { not: "SYSTEM" } }, // notas internas não saem
            orderBy: { seq: "asc" },
            select: { id: true, seq: true, role: true, text: true, createdAt: true },
          },
        },
      });
      if (!conv) return reply.status(404).send({ error: "Conversation not found" });
      return conv;
    }
  );

  // Envia uma mensagem como operador (ex.: sistema do cliente a responder).
  fastify.post<{ Params: { id: string } }>(
    "/v1/conversations/:id/messages",
    { preHandler: [fastify.verifyScope("conversations:write")] },
    async (request, reply) => {
      const parsed = sendSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      const conv = await prisma.conversation.findFirst({
        where: { id: request.params.id, tenantId: request.apiKey!.tenantId },
        include: { inbox: true },
      });
      if (!conv) return reply.status(404).send({ error: "Conversation not found" });
      const msg = await appendMessage(fastify, conv, { role: "AGENT", text: parsed.data.text });
      await deliver(fastify, conv.inbox, conv, parsed.data.text, msg.id);
      return reply.status(201).send({ id: msg.id, seq: msg.seq, createdAt: msg.createdAt });
    }
  );
}
