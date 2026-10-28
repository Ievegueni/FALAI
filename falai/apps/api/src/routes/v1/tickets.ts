import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { addTicketNote, createTicket, linkInteraction, updateTicket } from "../../services/tickets.service.js";
import { emitWebhookAsync } from "../../services/webhookEmitter.service.js";
import {
  sendTicketError,
  ticketCreateSchema,
  ticketLinkSchema,
  ticketListInclude,
  ticketListQuery,
  ticketPatchSchema,
  ticketWhere,
} from "../tenant/tickets.js";

/**
 * Tickets na API pública. Mesmas regras do CRM; o autor dos eventos fica
 * vazio (é o sistema do cliente). `updatedAt` no PATCH é opcional aqui —
 * quem integra por API nem sempre tem o ecrã aberto.
 */
export async function v1TicketsRoutes(fastify: FastifyInstance): Promise<void> {
  const read = { preHandler: [fastify.verifyScope("tickets:read")] };
  const write = { preHandler: [fastify.verifyScope("tickets:write")] };

  fastify.get("/v1/tickets", read, async (request) => {
    const q = ticketListQuery.parse(request.query);
    const where = ticketWhere(request.apiKey!.tenantId, null, q);
    const [data, total] = await Promise.all([
      prisma.ticket.findMany({ where, include: ticketListInclude, orderBy: { updatedAt: "desc" }, skip: (q.page - 1) * q.perPage, take: q.perPage }),
      prisma.ticket.count({ where }),
    ]);
    return { data, total, page: q.page, perPage: q.perPage };
  });

  fastify.get<{ Params: { id: string } }>("/v1/tickets/:id", read, async (request, reply) => {
    const ticket = await prisma.ticket.findFirst({
      where: { id: request.params.id, tenantId: request.apiKey!.tenantId },
      include: {
        ...ticketListInclude,
        events: { orderBy: { createdAt: "asc" }, select: { type: true, fromValue: true, toValue: true, body: true, createdAt: true } },
        calls: { select: { id: true } },
        conversations: { select: { id: true } },
      },
    });
    if (!ticket) return reply.status(404).send({ error: "Ticket not found" });
    return ticket;
  });

  fastify.post("/v1/tickets", write, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const body = ticketCreateSchema.parse(request.body);
    try {
      const ticket = await createTicket(tenantId, null, { ...body, dueAt: body.dueAt ? new Date(body.dueAt) : null, source: "API" });
      emitWebhookAsync({ tenantId, event: "ticket.created", payload: { ticketId: ticket.id, number: ticket.number, contactId: ticket.contactId } });
      return reply.status(201).send(ticket);
    } catch (err) {
      return sendTicketError(reply, err);
    }
  });

  fastify.patch<{ Params: { id: string } }>("/v1/tickets/:id", write, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { updatedAt, dueAt, ...patch } = ticketPatchSchema.partial({ updatedAt: true }).parse(request.body);
    try {
      const { ticket, changed } = await updateTicket(
        tenantId,
        request.params.id,
        null,
        { ...patch, ...(dueAt !== undefined && { dueAt: dueAt ? new Date(dueAt) : null }) },
        updatedAt ? new Date(updatedAt) : undefined
      );
      if (changed) {
        emitWebhookAsync({ tenantId, event: "ticket.updated", payload: { ticketId: ticket.id, number: ticket.number, status: ticket.status, contactId: ticket.contactId } });
      }
      return ticket;
    } catch (err) {
      return sendTicketError(reply, err);
    }
  });

  fastify.post<{ Params: { id: string } }>("/v1/tickets/:id/notes", write, async (request, reply) => {
    const body = typeof (request.body as { body?: unknown })?.body === "string" ? (request.body as { body: string }).body.trim() : "";
    if (!body) return reply.status(400).send({ error: "body is required" });
    try {
      return reply.status(201).send(await addTicketNote(request.apiKey!.tenantId, request.params.id, null, body.slice(0, 10000)));
    } catch (err) {
      return sendTicketError(reply, err);
    }
  });

  fastify.post<{ Params: { id: string } }>("/v1/tickets/:id/links", write, async (request, reply) => {
    try {
      await linkInteraction(request.apiKey!.tenantId, request.params.id, null, ticketLinkSchema.parse(request.body), true);
      return reply.status(204).send();
    } catch (err) {
      return sendTicketError(reply, err);
    }
  });
}
