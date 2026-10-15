import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";

/**
 * Catálogo de produtos. Um produto é um nome comercial e uns defaults por cima
 * de um dos três tipos base (baseType), que é quem decide o comportamento.
 * Mudar o baseType propaga-se a Plan.productType dos planos ligados, porque é
 * esse campo que o resto do código lê.
 */
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  baseType: z.enum(["VOICE_AI", "CRM_BYO_PBX", "API_BYOM"]).default("VOICE_AI"),
  aiAgentsEnabled: z.boolean().default(true),
  clinicEnabled: z.boolean().default(false),
  smsEnabled: z.boolean().default(false),
  monthlyFeeCents: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

// Tira as chaves undefined (exactOptionalPropertyTypes): um PATCH só mexe no que é enviado.
const updateSchema = createSchema.partial().transform((b) =>
  Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as {
    [K in keyof typeof b]?: Exclude<(typeof b)[K], undefined>;
  },
);

export const adminProductsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/products
  fastify.get("/", { preHandler }, async () => {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { plans: true } } },
    });
    return { products };
  });

  // POST /admin/products
  fastify.post("/", { preHandler }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const admin = request.adminUser!;

    const product = await prisma.product.create({ data: { ...body, description: body.description ?? null } });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "product.created",
      targetType: "Product",
      targetId: product.id,
      after: product as unknown as object,
      ip: request.ip,
    });

    return reply.status(201).send({ product });
  });

  // PATCH /admin/products/:id
  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const body = updateSchema.parse(request.body);
    const admin = request.adminUser!;

    const existing = await prisma.product.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Produto não encontrado" });

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({ where: { id: existing.id }, data: body });
      if (body.baseType !== undefined && body.baseType !== existing.baseType) {
        await tx.plan.updateMany({ where: { productId: existing.id }, data: { productType: body.baseType } });
      }
      return updated;
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "product.updated",
      targetType: "Product",
      targetId: product.id,
      before: existing as unknown as object,
      after: product as unknown as object,
      ip: request.ip,
    });

    return { product };
  });

  // DELETE /admin/products/:id
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;

    const existing = await prisma.product.findUnique({
      where: { id: request.params.id },
      include: { _count: { select: { plans: true } } },
    });
    if (!existing) return reply.status(404).send({ error: "Produto não encontrado" });
    if (existing._count.plans > 0) {
      return reply.status(409).send({ error: "O produto tem planos associados. Desactive-o em vez de o remover." });
    }

    await prisma.product.delete({ where: { id: existing.id } });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "product.deleted",
      targetType: "Product",
      targetId: existing.id,
      before: existing as unknown as object,
      ip: request.ip,
    });

    return reply.status(204).send();
  });
};
