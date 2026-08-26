import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { reserveBalance, computeReservation, effectiveBillingMode } from "../../services/billing.service.js";
import { resolveOutboundExtension, NoOutboundLineError } from "../../services/outboundExtension.service.js";

export async function v1CallsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/calls — dial a number
  fastify.post("/v1/calls", { preHandler: [fastify.verifyScope("calls:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const body = request.body as {
      agentId: string;
      toNumber: string;
      variables?: Record<string, unknown>;
      contactId?: string;
    };

    if (!body.agentId || !body.toNumber) {
      return reply.status(400).send({ error: "agentId and toNumber are required" });
    }

    const [agent, tenant] = await Promise.all([
      prisma.agent.findUnique({
        where: { id: body.agentId, tenantId, deletedAt: null },
        select: { id: true, status: true, systemPrompt: true, ttsVoiceId: true, maxCallSeconds: true, maxTurnSeconds: true, escalationNumber: true },
      }),
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          balanceCents: true, creditLimitCents: true, billingModeOverride: true,
          plan: { select: { billingMode: true, pricePerMinuteCents: true, pricePerCallCents: true, maxConcurrent: true } },
        },
      }),
    ]);

    if (!agent) return reply.status(404).send({ error: "Agent not found" });
    if (agent.status !== "ACTIVE") return reply.status(422).send({ error: "Agent must be ACTIVE to place calls" });
    if (!tenant) return reply.status(404).send({ error: "Tenant not found" });

    // Resolve the tenant's own outbound line extension
    let fromExtension: string;
    try {
      fromExtension = await resolveOutboundExtension(tenantId);
    } catch (err) {
      if (err instanceof NoOutboundLineError) {
        return reply.status(422).send({ error: "No active outbound line configured for this tenant" });
      }
      throw err;
    }

    const price = {
      billingMode: effectiveBillingMode(tenant.plan.billingMode, tenant.billingModeOverride),
      pricePerMinuteCents: tenant.plan.pricePerMinuteCents,
      pricePerCallCents: tenant.plan.pricePerCallCents,
    };
    const estimatedCents = computeReservation(agent.maxCallSeconds, price);

    const reserved = await reserveBalance(tenantId, estimatedCents);
    if (!reserved) {
      return reply.status(402).send({ error: "Insufficient balance" });
    }

    // Create the DB record first so we can use the ID as the dial reference
    const call = await prisma.call.create({
      data: {
        tenantId,
        agentId: body.agentId,
        toNumber: body.toNumber,
        ...(body.variables !== undefined && { variables: body.variables as Prisma.InputJsonValue }),
        status: "DIALING",
        ...(body.contactId !== undefined && { contactId: body.contactId }),
        startedAt: new Date(),
      },
      select: { id: true, status: true, toNumber: true, agentId: true, createdAt: true },
    });

    let providerCallId: string;
    try {
      const result = await fastify.telephony.dial({
        fromExtension,
        to: body.toNumber,
        ref: call.id,
        tenantId,
      });
      providerCallId = result.providerCallId;
      await prisma.call.update({ where: { id: call.id }, data: { yeastarCallId: providerCallId } });
    } catch (err) {
      // Refund reserved balance and mark call as failed
      await Promise.all([
        prisma.$executeRaw`UPDATE "Tenant" SET "balanceCents" = "balanceCents" + ${estimatedCents} WHERE id = ${tenantId}`,
        prisma.call.update({ where: { id: call.id }, data: { status: "FAILED", failReason: "Dial error" } }),
      ]);
      fastify.log.error({ err }, "v1.calls.dial_failed");
      return reply.status(502).send({ error: "Failed to place call" });
    }

    await fastify.callEngine.registerCall({
      callId: call.id,
      agentId: body.agentId,
      tenantId,
      toNumber: body.toNumber,
      providerCallId,
      systemPrompt: agent.systemPrompt,
      ttsVoiceId: agent.ttsVoiceId,
      variables: body.variables ?? {},
      maxCallSeconds: agent.maxCallSeconds,
      maxTurnSeconds: agent.maxTurnSeconds,
      escalationNumber: agent.escalationNumber,
      reservedCents: estimatedCents,
      billingMode: price.billingMode,
      pricePerMinuteCents: price.pricePerMinuteCents,
      pricePerCallCents: price.pricePerCallCents,
    });

    return reply.status(202).send(call);
  });

  // GET /v1/calls/:id
  fastify.get("/v1/calls/:id", { preHandler: [fastify.verifyScope("calls:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const call = await prisma.call.findUnique({
      where: { id },
      select: {
        id: true, tenantId: true, agentId: true, toNumber: true, status: true,
        outcome: true, failReason: true, durationSecs: true, costCents: true, summary: true,
        campaignId: true, contactId: true, recordingUrl: true,
        startedAt: true, answeredAt: true, endedAt: true, createdAt: true,
        variables: true,
      },
    });

    if (!call || call.tenantId !== tenantId) {
      return reply.status(404).send({ error: "Call not found" });
    }

    return reply.send(call);
  });

  // GET /v1/calls
  fastify.get("/v1/calls", { preHandler: [fastify.verifyScope("calls:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const query = request.query as {
      limit?: string; offset?: string; status?: string; campaignId?: string; contactId?: string;
    };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);
    // Filtrar por campanha/contacto é o caminho directo para "como correu esta
    // campanha" e "o que aconteceu a este cliente".
    const where = {
      tenantId,
      ...(query.status && { status: query.status as never }),
      ...(query.campaignId && { campaignId: query.campaignId }),
      ...(query.contactId && { contactId: query.contactId }),
    };

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where,
        select: {
          id: true, agentId: true, toNumber: true, status: true,
          outcome: true, failReason: true, campaignId: true, contactId: true,
          durationSecs: true, costCents: true, startedAt: true, endedAt: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.call.count({ where }),
    ]);

    return reply.send({ data: calls, total, limit, offset });
  });
}
