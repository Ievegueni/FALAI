import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";

export async function v1CampaignsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/v1/campaigns", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const query = request.query as { limit?: string; offset?: string; status?: string };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);
    const where = { tenantId, ...(query.status && { status: query.status as never }) };

    const [campaigns, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        select: {
          id: true, name: true, status: true, mode: true, agentId: true,
          totalContacts: true, completed: true, failedCount: true,
          scheduleJson: true, createdAt: true, updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.campaign.count({ where }),
    ]);

    return reply.send({ data: campaigns, total, limit, offset });
  });

  fastify.get("/v1/campaigns/:id", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: {
        id: true, tenantId: true, name: true, status: true, mode: true, agentId: true, scriptText: true, ttsVoiceId: true,
        totalContacts: true, completed: true, failedCount: true,
        scheduleJson: true, retryPolicy: true, throttlePerMinute: true,
        summary: true, createdAt: true, updatedAt: true,
      },
    });

    if (!campaign || campaign.tenantId !== tenantId) return reply.status(404).send({ error: "Campaign not found" });
    return reply.send(campaign);
  });

  fastify.post("/v1/campaigns", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const body = request.body as {
      name: string;
      mode?: "VOICE_AI" | "FIXED_SCRIPT";
      agentId?: string;
      scriptText?: string;
      ttsVoiceId?: string;
      scheduleJson?: Record<string, unknown>;
      retryPolicy?: Record<string, unknown>;
      throttlePerMinute?: number;
    };

    if (!body.name) return reply.status(400).send({ error: "name is required" });

    const mode = body.mode ?? "VOICE_AI";
    if (mode !== "VOICE_AI" && mode !== "FIXED_SCRIPT") {
      return reply.status(400).send({ error: "mode must be VOICE_AI or FIXED_SCRIPT" });
    }
    if (mode === "FIXED_SCRIPT") {
      if (!body.scriptText || body.scriptText.trim().length < 10) {
        return reply.status(400).send({ error: "scriptText is required (min 10 chars) for FIXED_SCRIPT mode" });
      }
    } else if (!body.agentId) {
      return reply.status(400).send({ error: "agentId is required for VOICE_AI mode" });
    }

    if (body.agentId) {
      const agent = await prisma.agent.findUnique({
        where: { id: body.agentId, tenantId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!agent) return reply.status(404).send({ error: "Agent not found" });
      if (agent.status !== "ACTIVE") return reply.status(422).send({ error: "Agent must be ACTIVE" });
    }

    const campaign = await prisma.campaign.create({
      data: {
        tenantId,
        mode,
        name: body.name,
        ...(body.agentId !== undefined && { agentId: body.agentId }),
        ...(body.scriptText !== undefined && { scriptText: body.scriptText }),
        ...(body.ttsVoiceId !== undefined && { ttsVoiceId: body.ttsVoiceId }),
        ...(body.scheduleJson !== undefined && { scheduleJson: body.scheduleJson as Prisma.InputJsonValue }),
        ...(body.retryPolicy !== undefined && { retryPolicy: body.retryPolicy as Prisma.InputJsonValue }),
        ...(body.throttlePerMinute !== undefined && { throttlePerMinute: body.throttlePerMinute }),
      },
      select: { id: true, name: true, status: true, mode: true, agentId: true, createdAt: true },
    });

    return reply.status(201).send(campaign);
  });

  // POST /v1/campaigns/:id/contacts — bulk-attach existing contacts to a DRAFT/SCHEDULED campaign
  fastify.post("/v1/campaigns/:id/contacts", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { contactIds?: string[] };

    if (!Array.isArray(body.contactIds) || body.contactIds.length === 0 || body.contactIds.length > 5000) {
      return reply.status(400).send({ error: "contactIds must be a non-empty array of up to 5000 ids" });
    }

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (!["DRAFT", "SCHEDULED"].includes(campaign.status)) {
      return reply.status(400).send({ error: "Contacts can only be added to DRAFT or SCHEDULED campaigns" });
    }

    const validContacts = await prisma.contact.findMany({
      where: { id: { in: body.contactIds }, tenantId, optedOutAt: null },
      select: { id: true },
    });
    const validIds = new Set(validContacts.map((c) => c.id));
    const skipped = body.contactIds.filter((cid) => !validIds.has(cid));

    const created = await prisma.campaignContact.createMany({
      data: [...validIds].map((contactId) => ({ campaignId: campaign.id, contactId })),
      skipDuplicates: true,
    });

    return reply.send({ added: created.count, skipped: skipped.length, skippedIds: skipped });
  });

  // POST /v1/campaigns/:id/launch — start the campaign and dispatch calls immediately
  fastify.post("/v1/campaigns/:id/launch", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (!["DRAFT", "SCHEDULED", "PAUSED"].includes(campaign.status)) {
      return reply.status(400).send({ error: `Campaign cannot be launched from status ${campaign.status}` });
    }

    const pendingCount = await prisma.campaignContact.count({ where: { campaignId: campaign.id, status: "PENDING" } });
    if (pendingCount === 0) {
      return reply.status(400).send({ error: "Campaign has no pending contacts. Add contacts first." });
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "RUNNING", totalContacts: pendingCount },
    });

    fastify.campaignDispatcher.processNow(campaign.id).catch((err) =>
      fastify.log.error({ err, campaignId: campaign.id }, "v1.campaigns.launch.dispatch_error")
    );

    return reply.send({ ok: true, status: "RUNNING", pendingContacts: pendingCount });
  });
}
