import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { enqueueWebhook } from "../../services/webhookDispatch.service.js";

const REMOVABLE_STATUSES = ["PENDING", "QUEUED", "OPTED_OUT"] as const;

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

  // POST /v1/campaigns/:id/pause
  fastify.post("/v1/campaigns/:id/pause", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (campaign.status !== "RUNNING") {
      return reply.status(400).send({ error: "Only RUNNING campaigns can be paused" });
    }

    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });
    await enqueueWebhook({
      tenantId,
      event: "campaign.paused",
      payload: { campaignId: campaign.id, reason: "manual" },
    });

    return reply.send({ ok: true, status: "PAUSED" });
  });

  // POST /v1/campaigns/:id/resume — retoma exactamente de onde ficou
  fastify.post("/v1/campaigns/:id/resume", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (campaign.status !== "PAUSED") {
      return reply.status(400).send({ error: "Only PAUSED campaigns can be resumed" });
    }

    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "RUNNING" } });

    fastify.campaignDispatcher.processNow(campaign.id).catch((err) =>
      fastify.log.error({ err, campaignId: campaign.id }, "v1.campaigns.resume.dispatch_error")
    );

    return reply.send({ ok: true, status: "RUNNING" });
  });

  // POST /v1/campaigns/:id/cancel — contactos ainda por tentar ficam "não contactados", não "falhados"
  fastify.post("/v1/campaigns/:id/cancel", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (campaign.status === "DONE" || campaign.status === "CANCELLED") {
      return reply.status(400).send({ error: "Campaign already finished" });
    }

    await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaign.id }, data: { status: "CANCELLED" } }),
      prisma.campaignContact.updateMany({
        where: { campaignId: campaign.id, status: { in: ["PENDING", "QUEUED"] } },
        data: { status: "FAILED" },
      }),
    ]);

    return reply.send({ ok: true, status: "CANCELLED" });
  });

  // POST /v1/campaigns/:id/retry — body opcional { scope: "FAILED" | "ALL" } (default "ALL")
  fastify.post("/v1/campaigns/:id/retry", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { scope?: "FAILED" | "ALL" } | undefined;
    const scope = body?.scope ?? "ALL";

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (!["CANCELLED", "DONE"].includes(campaign.status)) {
      return reply.status(400).send({ error: "Only CANCELLED or DONE campaigns can be retried" });
    }

    // OPTED_OUT nunca volta a PENDING: quem pediu para não ser contactado fica
    // de fora de qualquer repetição, seja qual for o scope.
    await prisma.campaignContact.updateMany({
      where: {
        campaignId: campaign.id,
        ...(scope === "FAILED" ? { status: "FAILED" } : { status: { not: "OPTED_OUT" } }),
      },
      data: { status: "PENDING" },
    });

    const totalContacts = await prisma.campaignContact.count({
      where: { campaignId: campaign.id, status: { not: "OPTED_OUT" } },
    });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "RUNNING", completed: 0, failedCount: 0, totalContacts, summary: null },
    });

    fastify.campaignDispatcher.processNow(campaign.id).catch((err) =>
      fastify.log.error({ err, campaignId: campaign.id }, "v1.campaigns.retry.dispatch_error")
    );

    return reply.send({ ok: true, status: "RUNNING", totalContacts });
  });

  // GET /v1/campaigns/:id/report — quadro completo de eficácia da campanha
  fastify.get("/v1/campaigns/:id/report", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });

    const [callStats, contactStats, outcomeBreakdown, answeredCount] = await Promise.all([
      prisma.call.aggregate({
        where: { campaignId: campaign.id },
        _count: { id: true },
        _sum: { durationSecs: true, costCents: true },
        _avg: { durationSecs: true },
      }),
      prisma.campaignContact.groupBy({ by: ["status"], where: { campaignId: campaign.id }, _count: { status: true } }),
      prisma.call.groupBy({ by: ["outcome"], where: { campaignId: campaign.id }, _count: { id: true } }),
      prisma.call.count({ where: { campaignId: campaign.id, status: { in: ["COMPLETED", "ESCALATED"] } } }),
    ]);

    const contacted = contactStats
      .filter((s) => !["PENDING", "QUEUED", "OPTED_OUT"].includes(s.status))
      .reduce((sum, s) => sum + s._count.status, 0);

    return reply.send({
      campaignId: campaign.id,
      name: campaign.name,
      status: campaign.status,
      totalContacts: campaign.totalContacts,
      contacted,
      answered: answeredCount,
      failed: campaign.failedCount,
      notContacted: contactStats.find((s) => s.status === "PENDING")?._count.status ?? 0,
      optedOut: contactStats.find((s) => s.status === "OPTED_OUT")?._count.status ?? 0,
      answerRate: contacted > 0 ? Number((answeredCount / contacted).toFixed(4)) : 0,
      totalDurationSecs: callStats._sum.durationSecs ?? 0,
      avgDurationSecs: Math.round(callStats._avg.durationSecs ?? 0),
      totalCostCents: callStats._sum.costCents ?? 0,
      contactStatuses: Object.fromEntries(contactStats.map((s) => [s.status, s._count.status])),
      outcomes: Object.fromEntries(outcomeBreakdown.map((o) => [o.outcome ?? "unknown", o._count.id])),
    });
  });

  // GET /v1/campaigns/:id/contacts — lista nominal dos participantes, com estado e resultado
  fastify.get("/v1/campaigns/:id/contacts", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 100);
    const offset = parseInt(query.offset ?? "0", 10);

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });

    const where = {
      campaignId: campaign.id,
      ...(query.status && { status: query.status as never }),
    };

    const [participants, total] = await Promise.all([
      prisma.campaignContact.findMany({
        where,
        select: {
          callId: true, status: true, attempts: true, nextRetryAt: true, createdAt: true, updatedAt: true,
          contact: { select: { id: true, phone: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
        take: limit,
        skip: offset,
      }),
      prisma.campaignContact.count({ where }),
    ]);

    // CampaignContact.callId não tem relação navegável no schema — junta-se manualmente.
    const callIds = participants.map((p) => p.callId).filter((cid): cid is string => cid !== null);
    const calls = callIds.length > 0
      ? await prisma.call.findMany({
          where: { id: { in: callIds } },
          select: { id: true, outcome: true, failReason: true, durationSecs: true, costCents: true, recordingUrl: true, endedAt: true },
        })
      : [];
    const callById = new Map(calls.map((c) => [c.id, c]));

    const data = participants.map(({ callId, ...p }) => ({
      ...p,
      call: callId ? (callById.get(callId) ?? null) : null,
    }));

    return reply.send({ data, total, limit, offset });
  });

  // DELETE /v1/campaigns/:id/contacts/:contactId — remove 1 contacto ainda não contactado
  fastify.delete("/v1/campaigns/:id/contacts/:contactId", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id, contactId } = request.params as { id: string; contactId: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });

    const cc = await prisma.campaignContact.findUnique({
      where: { campaignId_contactId: { campaignId: campaign.id, contactId } },
    });
    if (!cc) return reply.status(404).send({ error: "Contact not found in this campaign" });
    if (!REMOVABLE_STATUSES.includes(cc.status as (typeof REMOVABLE_STATUSES)[number])) {
      return reply.status(400).send({
        error: "Contact was already contacted and cannot be removed. Use contact opt-out to prevent future attempts.",
      });
    }

    await prisma.campaignContact.delete({ where: { id: cc.id } });
    return reply.status(204).send();
  });

  // POST /v1/campaigns/:id/contacts/remove — remoção em lote, body { contactIds: [...] }
  fastify.post("/v1/campaigns/:id/contacts/remove", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { contactIds?: string[] };

    if (!Array.isArray(body.contactIds) || body.contactIds.length === 0 || body.contactIds.length > 5000) {
      return reply.status(400).send({ error: "contactIds must be a non-empty array of up to 5000 ids" });
    }

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });

    const candidates = await prisma.campaignContact.findMany({
      where: { campaignId: campaign.id, contactId: { in: body.contactIds } },
      select: { id: true, contactId: true, status: true },
    });

    const removable = candidates.filter((c) => REMOVABLE_STATUSES.includes(c.status as (typeof REMOVABLE_STATUSES)[number]));
    const skippedIds = candidates
      .filter((c) => !REMOVABLE_STATUSES.includes(c.status as (typeof REMOVABLE_STATUSES)[number]))
      .map((c) => c.contactId);
    const notFoundIds = body.contactIds.filter((cid) => !candidates.some((c) => c.contactId === cid));

    if (removable.length > 0) {
      await prisma.campaignContact.deleteMany({ where: { id: { in: removable.map((c) => c.id) } } });
    }

    return reply.send({
      removed: removable.length,
      skipped: skippedIds.length + notFoundIds.length,
      skippedIds: [...skippedIds, ...notFoundIds],
    });
  });
}
