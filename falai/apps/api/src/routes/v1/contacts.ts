import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("244") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("00244") && digits.length === 14) return `+${digits.slice(2)}`;
  if (digits.length === 9) return `+244${digits}`;
  return `+${digits}`;
}

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
    const phone = normalizePhone(body.phone);

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
}
