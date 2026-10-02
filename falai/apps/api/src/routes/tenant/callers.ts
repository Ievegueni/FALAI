import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { normalizeAoPhone } from "@falai/shared";
import {
  buildCallerPanel,
  contactHistory,
  phoneOwner,
} from "../../services/callerLookup.service.js";

/**
 * Painel do cliente na entrada da chamada (melhoria 3/4) — ver
 * services/callerLookup.service.ts. Tudo isolado por tenant; cada consulta do
 * histórico fica no AuditLog (contact.history_viewed).
 *
 * Abre-se pelo webphone (perna do INVITE, X-Falai-Leg-Id) ou pelo número
 * (banner do PBX próprio). Serve quem tem webphone ou o histórico de chamadas.
 */

const config = { feature: ["webphone", "calls"] as ("webphone" | "calls")[] };
const INVALID_PHONE = "Número inválido. Use o formato nacional de 9 dígitos (ex: 923 456 789).";

const lookupSchema = z.object({ legId: z.string().optional(), number: z.string().optional() });
const historySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const quickCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().min(6).max(30),
  legId: z.string().optional(), // liga a chamada em curso ao contacto novo
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
});
const phoneSchema = z.object({ phone: z.string().min(6).max(30), label: z.string().trim().max(40).optional() });
const noteSchema = z.object({ body: z.string().trim().min(1).max(4000), legId: z.string().optional() });

export const tenantCallersRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  const audit = (request: FastifyRequest, contactId: string, after: Record<string, unknown>) =>
    fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      tenantId: request.tenantUser!.tenantId,
      action: "contact.history_viewed",
      targetType: "Contact",
      targetId: contactId,
      after,
      ip: request.ip,
    });

  // GET /tenant/callers/lookup?legId=…|number=…
  fastify.get("/tenant/callers/lookup", { preHandler, config }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const q = lookupSchema.parse(request.query);
    let raw: string | null | undefined = q.number;
    let callId: string | null = null;
    if (q.legId) {
      const leg = await prisma.callLeg.findFirst({
        where: { id: q.legId, tenantId },
        select: { callId: true, call: { select: { fromNumber: true } } },
      });
      if (!leg) return reply.status(404).send({ error: "Chamada não encontrada" });
      raw = leg.call.fromNumber;
      callId = leg.callId;
    } else if (q.number === undefined) {
      return reply.status(400).send({ error: "Indique legId ou number" });
    }

    const panel = await buildCallerPanel(tenantId, raw);
    if (panel.contact) await audit(request, panel.contact.id, { via: q.legId ? "leg" : "number", callId });
    return { ...panel, callId };
  });

  // GET /tenant/callers/:contactId/history?before=&limit= — "ver mais"
  fastify.get<{ Params: { contactId: string } }>("/tenant/callers/:contactId/history", { preHandler, config }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const q = historySchema.parse(request.query);
    const exists = await prisma.contact.count({ where: { id: request.params.contactId, tenantId } });
    if (!exists) return reply.status(404).send({ error: "Contacto não encontrado" });
    await audit(request, request.params.contactId, { via: "history", before: q.before ?? null });
    return contactHistory(tenantId, request.params.contactId, q.limit, q.before ? new Date(q.before) : undefined);
  });

  // POST /tenant/callers/contacts — contacto rápido para um número não identificado
  fastify.post("/tenant/callers/contacts", { preHandler, config }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = quickCreateSchema.parse(request.body);
    const phone = normalizeAoPhone(body.phone);
    if (!phone) return reply.status(400).send({ error: INVALID_PHONE });
    const owner = await phoneOwner(tenantId, phone);
    if (owner) return reply.status(409).send({ error: "Este número já pertence a um contacto", contactId: owner });

    const contact = await prisma.contact.create({ data: { tenantId, phone, name: body.name }, select: { id: true } });
    if (body.legId) await linkCallToContact(tenantId, body.legId, contact.id);
    return reply.status(201).send(contact);
  });

  // PATCH /tenant/callers/:contactId — editar durante a chamada
  fastify.patch<{ Params: { contactId: string } }>("/tenant/callers/:contactId", { preHandler, config }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = updateSchema.parse(request.body);
    const res = await prisma.contact
      .updateMany({
        where: { id: request.params.contactId, tenantId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.email !== undefined && { email: body.email }),
        },
      })
      .catch(() => null);
    if (!res) return reply.status(409).send({ error: "Já existe um contacto com este email" });
    if (res.count === 0) return reply.status(404).send({ error: "Contacto não encontrado" });
    return { ok: true };
  });

  // POST /tenant/callers/:contactId/phones — número extra
  fastify.post<{ Params: { contactId: string } }>("/tenant/callers/:contactId/phones", { preHandler, config }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = phoneSchema.parse(request.body);
    const phone = normalizeAoPhone(body.phone);
    if (!phone) return reply.status(400).send({ error: INVALID_PHONE });
    const exists = await prisma.contact.count({ where: { id: request.params.contactId, tenantId } });
    if (!exists) return reply.status(404).send({ error: "Contacto não encontrado" });
    const owner = await phoneOwner(tenantId, phone);
    if (owner) {
      return reply
        .status(409)
        .send({ error: owner === request.params.contactId ? "O contacto já tem este número" : "Este número já pertence a outro contacto" });
    }
    const row = await prisma.contactPhone.create({
      data: { tenantId, contactId: request.params.contactId, phone, ...(body.label && { label: body.label }) },
      select: { id: true, phone: true, label: true },
    });
    return reply.status(201).send(row);
  });

  fastify.delete<{ Params: { contactId: string; phoneId: string } }>(
    "/tenant/callers/:contactId/phones/:phoneId",
    { preHandler, config },
    async (request, reply) => {
      const { tenantId } = request.tenantUser!;
      const res = await prisma.contactPhone.deleteMany({
        where: { id: request.params.phoneId, contactId: request.params.contactId, tenantId },
      });
      if (res.count === 0) return reply.status(404).send({ error: "Número não encontrado" });
      return reply.status(204).send();
    }
  );

  // POST /tenant/callers/:contactId/notes — nota do agente (ligada à chamada em curso, se houver)
  fastify.post<{ Params: { contactId: string } }>("/tenant/callers/:contactId/notes", { preHandler, config }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const body = noteSchema.parse(request.body);
    const exists = await prisma.contact.count({ where: { id: request.params.contactId, tenantId } });
    if (!exists) return reply.status(404).send({ error: "Contacto não encontrado" });
    let callId: string | null = null;
    if (body.legId) {
      const leg = await prisma.callLeg.findFirst({ where: { id: body.legId, tenantId }, select: { callId: true } });
      callId = leg?.callId ?? null;
    }
    const note = await prisma.contactNote.create({
      data: { tenantId, contactId: request.params.contactId, authorId: sub, body: body.body, callId },
      select: { id: true, body: true, createdAt: true, callId: true },
    });
    return reply.status(201).send(note);
  });
};

/**
 * Liga a chamada da perna ao contacto (contacto criado a meio da chamada). Só
 * se a chamada ainda não tiver cliente — nunca troca um que já lá estava.
 */
async function linkCallToContact(tenantId: string, legId: string, contactId: string): Promise<void> {
  const leg = await prisma.callLeg.findFirst({ where: { id: legId, tenantId }, select: { callId: true } });
  if (leg) await prisma.call.updateMany({ where: { id: leg.callId, tenantId, contactId: null }, data: { contactId } });
}
