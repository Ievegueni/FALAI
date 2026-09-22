import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { normalizeAoPhone, INVALID_PHONE_MESSAGE as INVALID_PHONE } from "@falai/shared";

export async function v1ContactsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/contacts", { preHandler: [fastify.verifyScope("contacts:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const query = request.query as { limit?: string; offset?: string; search?: string };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);
    const where = {
      tenantId,
      ...(query.search && {
        OR: [
          { phone: { contains: query.search } },
          { name: { contains: query.search, mode: "insensitive" as const } },
        ],
      }),
    };

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        select: { id: true, phone: true, name: true, attributes: true, optedOutAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.contact.count({ where }),
    ]);

    return reply.send({ data: contacts, total, limit, offset });
  });

  fastify.post("/v1/contacts", { preHandler: [fastify.verifyScope("contacts:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const body = request.body as { phone: string; name?: string; attributes?: Record<string, unknown> };

    if (!body.phone) return reply.status(400).send({ error: "phone is required" });
    const phone = normalizeAoPhone(body.phone);
    if (!phone) return reply.status(400).send({ error: INVALID_PHONE });

    const contact = await prisma.contact.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: {
        tenantId, phone,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.attributes !== undefined && { attributes: body.attributes as Prisma.InputJsonValue }),
      },
      update: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.attributes !== undefined && { attributes: body.attributes as Prisma.InputJsonValue }),
      },
      select: { id: true, phone: true, name: true, attributes: true, optedOutAt: true, createdAt: true },
    });

    return reply.status(201).send(contact);
  });

  // POST /v1/contacts/bulk — cria até 1000 contactos num único pedido, para
  // não gastar uma chamada (e um slot de rate-limit) por contacto ao carregar
  // uma lista. Números repetidos são ignorados; use PATCH para actualizar.
  //
  // `skipped` agrega dois casos distintos, que agora vêm também discriminados
  // em `existing` e `duplicatesInPayload`: o número já existir no tenant (a
  // chave única é (tenantId, phone)) e o número vir repetido no mesmo payload.
  // Números mal formados nunca entram em `skipped`, saem em `invalid`.
  //
  // Com `results: true` (no body ou em `?results=true`) devolve ainda uma
  // linha por cada entrada recebida, com o id do contacto. É a única forma de
  // obter os ids dos que já existiam, porque o insert em lote só devolve uma
  // contagem. Sem a flag o formato da resposta mantém-se inalterado.
  fastify.post("/v1/contacts/bulk", { preHandler: [fastify.verifyScope("contacts:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const body = request.body as {
      contacts?: Array<{ phone?: string; name?: string; attributes?: Record<string, unknown> }>;
      results?: boolean;
    };
    const query = request.query as { results?: string };
    const wantResults = body.results === true || query.results === "true";

    if (!Array.isArray(body.contacts) || body.contacts.length === 0) {
      return reply.status(400).send({ error: "contacts must be a non-empty array" });
    }
    if (body.contacts.length > 1000) {
      return reply.status(400).send({ error: "contacts is limited to 1000 entries per request" });
    }

    type RowOutcome = "created" | "existing" | "duplicate_in_payload" | "invalid";
    const rows: Array<{ index: number; phone: string | null; outcome: RowOutcome; reason?: string }> = [];
    const valid: Array<{ tenantId: string; phone: string; name?: string; attributes?: Prisma.InputJsonValue }> = [];
    const invalid: Array<{ index: number; reason: string }> = [];
    const seen = new Set<string>();
    let duplicatesInPayload = 0;

    body.contacts.forEach((c, index) => {
      if (!c || typeof c.phone !== "string" || !c.phone.trim()) {
        invalid.push({ index, reason: "phone is required" });
        rows.push({ index, phone: null, outcome: "invalid", reason: "phone is required" });
        return;
      }
      const phone = normalizeAoPhone(c.phone);
      if (!phone) {
        invalid.push({ index, reason: INVALID_PHONE });
        rows.push({ index, phone: null, outcome: "invalid", reason: INVALID_PHONE });
        return;
      }
      if (seen.has(phone)) {
        duplicatesInPayload++;
        rows.push({ index, phone, outcome: "duplicate_in_payload" });
        return;
      }
      seen.add(phone);
      rows.push({ index, phone, outcome: "created" });
      valid.push({
        tenantId, phone,
        ...(c.name !== undefined && { name: c.name }),
        ...(c.attributes !== undefined && { attributes: c.attributes as Prisma.InputJsonValue }),
      });
    });

    // Quem já existia antes do insert. Precisamos disto antes do createMany
    // para distinguir "created" de "existing" — depois já é indistinguível.
    const phones = [...seen];
    const existingBefore = phones.length
      ? new Set(
          (await prisma.contact.findMany({ where: { tenantId, phone: { in: phones } }, select: { phone: true } }))
            .map((c) => c.phone)
        )
      : new Set<string>();

    const { count: created } = valid.length
      ? await prisma.contact.createMany({ data: valid, skipDuplicates: true })
      : { count: 0 };

    const payload: Record<string, unknown> = {
      created,
      skipped: valid.length - created + duplicatesInPayload,
      existing: existingBefore.size,
      duplicatesInPayload,
      invalid,
      received: body.contacts.length,
    };

    if (wantResults) {
      const idByPhone = phones.length
        ? new Map(
            (await prisma.contact.findMany({ where: { tenantId, phone: { in: phones } }, select: { id: true, phone: true } }))
              .map((c) => [c.phone, c.id] as const)
          )
        : new Map<string, string>();

      payload.results = rows.map((r) => ({
        index: r.index,
        phone: r.phone,
        contactId: r.phone ? idByPhone.get(r.phone) ?? null : null,
        outcome: r.outcome === "created" && existingBefore.has(r.phone!) ? "existing" : r.outcome,
        ...(r.reason !== undefined && { reason: r.reason }),
      }));
    }

    return reply.status(201).send(payload);
  });

  fastify.get("/v1/contacts/:id", { preHandler: [fastify.verifyScope("contacts:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const contact = await prisma.contact.findUnique({
      where: { id },
      select: { id: true, tenantId: true, phone: true, name: true, attributes: true, optedOutAt: true, optOutReason: true, createdAt: true, updatedAt: true },
    });

    if (!contact || contact.tenantId !== tenantId) return reply.status(404).send({ error: "Contact not found" });
    return reply.send(contact);
  });

  fastify.patch("/v1/contacts/:id", { preHandler: [fastify.verifyScope("contacts:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; attributes?: Record<string, unknown> };

    const existing = await prisma.contact.findUnique({ where: { id }, select: { tenantId: true } });
    if (!existing || existing.tenantId !== tenantId) return reply.status(404).send({ error: "Contact not found" });

    const contact = await prisma.contact.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.attributes !== undefined && { attributes: body.attributes as Prisma.InputJsonValue }),
      },
      select: { id: true, phone: true, name: true, attributes: true, optedOutAt: true, updatedAt: true },
    });

    return reply.send(contact);
  });

  fastify.delete("/v1/contacts/:id", { preHandler: [fastify.verifyScope("contacts:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const existing = await prisma.contact.findUnique({ where: { id }, select: { tenantId: true } });
    if (!existing || existing.tenantId !== tenantId) return reply.status(404).send({ error: "Contact not found" });

    await prisma.contact.delete({ where: { id } });
    return reply.status(204).send();
  });

  // POST /v1/contacts/:id/opt-out — impede permanentemente que o contacto seja contactado,
  // em qualquer campanha presente ou futura. Não apaga histórico de chamadas já feitas.
  fastify.post("/v1/contacts/:id/opt-out", { preHandler: [fastify.verifyScope("contacts:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { reason?: string } | undefined;

    const existing = await prisma.contact.findUnique({ where: { id }, select: { tenantId: true, optedOutAt: true } });
    if (!existing || existing.tenantId !== tenantId) return reply.status(404).send({ error: "Contact not found" });
    if (existing.optedOutAt) return reply.status(400).send({ error: "Contact already opted out" });

    const contact = await prisma.contact.update({
      where: { id },
      data: { optedOutAt: new Date(), optOutReason: body?.reason ?? "Solicitado via API" },
      select: { id: true, phone: true, name: true, optedOutAt: true, optOutReason: true },
    });

    return reply.send(contact);
  });
}
