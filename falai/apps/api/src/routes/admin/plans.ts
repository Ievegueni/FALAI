import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  productType: z.enum(["VOICE_AI", "CRM_BYO_PBX"]).default("VOICE_AI"),
  aiAgentsEnabled: z.boolean().default(true),
  pricePerMinuteCents: z.number().int().min(0),
  pricePerCallCents: z.number().int().min(0).default(0),
  includedMinutes: z.number().int().min(0).default(0),
  monthlyFeeCents: z.number().int().min(0).default(0),
  maxAgents: z.number().int().min(1).default(1),
  maxConcurrent: z.number().int().min(1).default(1),
  sttMarginPct: z.number().int().min(0).max(200).default(30),
  isActive: z.boolean().default(true),
});

const updateSchema = createSchema.partial();

export const adminPlansRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/plans
  fastify.get("/", { preHandler }, async () => {
    const plans = await prisma.plan.findMany({ orderBy: { createdAt: "asc" } });
    return { plans };
  });

  // POST /admin/plans
  fastify.post("/", { preHandler }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const admin = request.adminUser!;

    const plan = await prisma.plan.create({ data: body });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "plan.created",
      targetType: "Plan",
      targetId: plan.id,
      after: plan as unknown as object,
      ip: request.ip,
    });

    return reply.status(201).send({ plan });
  });

  // GET /admin/plans/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const plan = await prisma.plan.findUnique({ where: { id: request.params.id } });
    if (!plan) return reply.status(404).send({ error: "Plano não encontrado" });
    return { plan };
  });

  // PATCH /admin/plans/:id
  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const body = updateSchema.parse(request.body);
    const admin = request.adminUser!;

    const existing = await prisma.plan.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Plano não encontrado" });

    const plan = await prisma.plan.update({
      where: { id: request.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.productType !== undefined && { productType: body.productType }),
        ...(body.aiAgentsEnabled !== undefined && { aiAgentsEnabled: body.aiAgentsEnabled }),
        ...(body.pricePerMinuteCents !== undefined && { pricePerMinuteCents: body.pricePerMinuteCents }),
        ...(body.pricePerCallCents !== undefined && { pricePerCallCents: body.pricePerCallCents }),
        ...(body.includedMinutes !== undefined && { includedMinutes: body.includedMinutes }),
        ...(body.monthlyFeeCents !== undefined && { monthlyFeeCents: body.monthlyFeeCents }),
        ...(body.maxAgents !== undefined && { maxAgents: body.maxAgents }),
        ...(body.maxConcurrent !== undefined && { maxConcurrent: body.maxConcurrent }),
        ...(body.sttMarginPct !== undefined && { sttMarginPct: body.sttMarginPct }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "plan.updated",
      targetType: "Plan",
      targetId: plan.id,
      before: existing as unknown as object,
      after: plan as unknown as object,
      ip: request.ip,
    });

    return { plan };
  });
};
