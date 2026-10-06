import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { z } from "zod";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketError,
  addTicketNote,
  createTicket,
  linkInteraction,
  updateTicket,
} from "../../services/tickets.service.js";
import { emitWebhookAsync } from "../../services/webhookEmitter.service.js";

/**
 * Tickets nativos (centro de atendimento, fase 1) — ver services/tickets.service.ts.
 * Leitura: todos os utilizadores do tenant. Escrita: todos menos VIEWER.
 * ponytail: "o agente só vê o que é seu" é a fase 2 do plano.
 */

const nullableId = z.string().min(1).nullable().optional();

const createSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10000).nullable().optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  supportLevel: z.number().int().min(1).max(3).optional(),
  contactId: nullableId,
  assigneeId: nullableId,
  groupId: nullableId,
  categoryId: nullableId,
  subcategoryId: nullableId,
  dueAt: z.string().datetime().nullable().optional(),
  callId: nullableId,
  conversationId: nullableId,
});

const patchSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(10000).nullable().optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  supportLevel: z.number().int().min(1).max(3).optional(),
  assigneeId: nullableId,
  groupId: nullableId,
  categoryId: nullableId,
  subcategoryId: nullableId,
  dueAt: z.string().datetime().nullable().optional(),
  /** Bloqueio optimista: o updatedAt que o operador tinha no ecrã. */
  updatedAt: z.string().datetime(),
});

const listQuery = z.object({
  status: z.string().optional(), // um ou vários separados por vírgula; "active" = tudo menos RESOLVED/CLOSED
  priority: z.enum(TICKET_PRIORITIES).optional(),
  supportLevel: z.coerce.number().int().min(1).max(3).optional(),
  assignee: z.string().optional(), // "me" | "none" | TenantUser.id
  groupId: z.string().optional(),
  contactId: z.string().optional(),
  q: z.string().trim().max(100).optional(), // número (#123 ou 123) ou parte do assunto
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

const linkSchema = z.object({ callId: z.string().optional(), conversationId: z.string().optional() }).refine(
  (v) => !!v.callId !== !!v.conversationId,
  "Indique callId ou conversationId"
);

export const ticketListInclude = {
  contact: { select: { id: true, name: true, phone: true, email: true } },
  assignee: { select: { id: true, name: true } },
  group: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  subcategory: { select: { id: true, name: true } },
} satisfies Prisma.TicketInclude;

export function ticketWhere(tenantId: string, userId: string | null, q: z.infer<typeof listQuery>): Prisma.TicketWhereInput {
  const statuses = q.status === "active"
    ? ["OPEN", "PENDING", "ON_HOLD"]
    : q.status?.split(",").filter((s) => (TICKET_STATUSES as readonly string[]).includes(s));
  const num = q.q?.replace(/^#/, "");
  return {
    tenantId,
    ...(statuses?.length && { status: { in: statuses as (typeof TICKET_STATUSES)[number][] } }),
    ...(q.priority && { priority: q.priority }),
    ...(q.supportLevel && { supportLevel: q.supportLevel }),
    ...(q.assignee === "me" && userId && { assigneeId: userId }),
    ...(q.assignee === "none" && { assigneeId: null }),
    ...(q.assignee && !["me", "none"].includes(q.assignee) && { assigneeId: q.assignee }),
    ...(q.groupId && { groupId: q.groupId }),
    ...(q.contactId && { contactId: q.contactId }),
    ...(q.q && {
      OR: [
        ...(/^\d+$/.test(num!) ? [{ number: Number(num) }] : []),
        { subject: { contains: q.q, mode: "insensitive" as const } },
      ],
    }),
  };
}

export { listQuery as ticketListQuery, createSchema as ticketCreateSchema, patchSchema as ticketPatchSchema, linkSchema as ticketLinkSchema };

export function sendTicketError(reply: FastifyReply, err: unknown) {
  if (err instanceof TicketError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

export const tenantTicketsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];
  const canWrite = (role: string) => role !== "VIEWER";

  // GET /tenant/tickets/meta — opções dos formulários (utilizadores, grupos, categorias).
  // Aqui e não nas rotas de cada módulo: essas estão atrás de outras features.
  fastify.get("/tenant/tickets/meta", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const [users, groups, categories] = await Promise.all([
      prisma.tenantUser.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.extensionGroup.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      prisma.callCategory.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, parentId: true, name: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
    ]);
    return { users, groups, categories };
  });

  // GET /tenant/tickets
  fastify.get("/tenant/tickets", { preHandler }, async (request) => {
    const { tenantId, sub } = request.tenantUser!;
    const q = listQuery.parse(request.query);
    const where = ticketWhere(tenantId, sub, q);
    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        include: ticketListInclude,
        orderBy: { updatedAt: "desc" },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
      prisma.ticket.count({ where }),
    ]);
    return { data, total, page: q.page, perPage: q.perPage };
  });

  // GET /tenant/tickets/:id — ticket + linha do tempo + interacções ligadas
  fastify.get<{ Params: { id: string } }>("/tenant/tickets/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const ticket = await prisma.ticket.findFirst({
      where: { id: request.params.id, tenantId },
      include: {
        ...ticketListInclude,
        events: { orderBy: { createdAt: "asc" }, include: { author: { select: { id: true, name: true } } } },
        calls: {
          orderBy: { createdAt: "desc" },
          select: { id: true, kind: true, status: true, fromNumber: true, toNumber: true, startedAt: true, durationSecs: true, createdAt: true },
        },
        conversations: {
          orderBy: { lastMessageAt: "desc" },
          select: { id: true, status: true, lastMessageAt: true, inbox: { select: { name: true, channel: true } } },
        },
      },
    });
    if (!ticket) return reply.status(404).send({ error: "Ticket não encontrado" });
    return ticket;
  });

  // POST /tenant/tickets
  fastify.post("/tenant/tickets", { preHandler }, async (request, reply) => {
    const { tenantId, sub, role } = request.tenantUser!;
    if (!canWrite(role)) return reply.status(403).send({ error: "Sem permissão" });
    const body = createSchema.parse(request.body);
    try {
      const ticket = await createTicket(tenantId, sub, {
        ...body,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        ...(body.conversationId && { source: await conversationSource(body.conversationId) }),
      });
      emitWebhookAsync({ tenantId, event: "ticket.created", payload: { ticketId: ticket.id, number: ticket.number, contactId: ticket.contactId } });
      return reply.status(201).send(ticket);
    } catch (err) {
      return sendTicketError(reply, err);
    }
  });

  // PATCH /tenant/tickets/:id — estado, prioridade, nível, responsável, grupo, categoria
  fastify.patch<{ Params: { id: string } }>("/tenant/tickets/:id", { preHandler }, async (request, reply) => {
    const { tenantId, sub, role } = request.tenantUser!;
    if (!canWrite(role)) return reply.status(403).send({ error: "Sem permissão" });
    const { updatedAt, dueAt, ...patch } = patchSchema.parse(request.body);
    try {
      const { ticket, changed } = await updateTicket(
        tenantId,
        request.params.id,
        sub,
        { ...patch, ...(dueAt !== undefined && { dueAt: dueAt ? new Date(dueAt) : null }) },
        new Date(updatedAt)
      );
      if (changed) {
        emitWebhookAsync({ tenantId, event: "ticket.updated", payload: { ticketId: ticket.id, number: ticket.number, status: ticket.status, contactId: ticket.contactId } });
      }
      return ticket;
    } catch (err) {
      return sendTicketError(reply, err);
    }
  });

  // POST /tenant/tickets/:id/notes — nota interna
  fastify.post<{ Params: { id: string } }>("/tenant/tickets/:id/notes", { preHandler }, async (request, reply) => {
    const { tenantId, sub, role } = request.tenantUser!;
    if (!canWrite(role)) return reply.status(403).send({ error: "Sem permissão" });
    const { body } = z.object({ body: z.string().trim().min(1).max(10000) }).parse(request.body);
    try {
      return reply.status(201).send(await addTicketNote(tenantId, request.params.id, sub, body));
    } catch (err) {
      return sendTicketError(reply, err);
    }
  });

  // POST/DELETE /tenant/tickets/:id/links — associar chamada ou conversa
  for (const method of ["POST", "DELETE"] as const) {
    fastify.route<{ Params: { id: string } }>({
      method,
      url: "/tenant/tickets/:id/links",
      preHandler,
      handler: async (request, reply) => {
        const { tenantId, sub, role } = request.tenantUser!;
        if (!canWrite(role)) return reply.status(403).send({ error: "Sem permissão" });
        const target = linkSchema.parse(request.body);
        try {
          await linkInteraction(tenantId, request.params.id, sub, target, method === "POST");
          return reply.status(204).send();
        } catch (err) {
          return sendTicketError(reply, err);
        }
      },
    });
  }
};

async function conversationSource(conversationId: string): Promise<string> {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { inbox: { select: { channel: true } } } });
  return conv?.inbox.channel ?? "MANUAL";
}
