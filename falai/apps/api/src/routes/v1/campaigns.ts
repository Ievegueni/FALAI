import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { emitWebhookAsync } from "../../services/webhookEmitter.service.js";

/** Estados em que ainda faz sentido mexer na lista de contactos da campanha. */
const CONTACT_EDITABLE_STATUSES = ["DRAFT", "SCHEDULED", "PAUSED", "RUNNING"];

async function syncTotalContacts(campaignId: string): Promise<number> {
  const total = await prisma.campaignContact.count({ where: { campaignId } });
  await prisma.campaign.update({ where: { id: campaignId }, data: { totalContacts: total } });
  return total;
}

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
    // Também com a campanha a decorrer: os novos contactos entram como PENDING.
    if (!CONTACT_EDITABLE_STATUSES.includes(campaign.status)) {
      return reply.status(400).send({ error: "Campaign is finished or cancelled — contacts cannot be added" });
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

    const totalContacts = await syncTotalContacts(campaign.id);

    return reply.send({ added: created.count, skipped: skipped.length, skippedIds: skipped, totalContacts });
  });

  // GET /v1/campaigns/:id/contacts — participante a participante, com o desfecho
  // de cada um (atendeu, falhou e porquê, quantas tentativas, gravação).
  fastify.get("/v1/campaigns/:id/contacts", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 200);
    const offset = parseInt(query.offset ?? "0", 10);

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });

    const where = {
      campaignId: campaign.id,
      ...(query.status && { status: query.status as import("@falai/db").CampaignContactStatus }),
    };

    const [rows, total] = await Promise.all([
      prisma.campaignContact.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          status: true, attempts: true, nextRetryAt: true, callId: true, updatedAt: true,
          contact: { select: { id: true, name: true, phone: true, optedOutAt: true } },
        },
      }),
      prisma.campaignContact.count({ where }),
    ]);

    const callIds = rows.map((r) => r.callId).filter((v): v is string => !!v);
    const calls = callIds.length
      ? await prisma.call.findMany({
          where: { id: { in: callIds } },
          select: {
            id: true, status: true, outcome: true, failReason: true,
            durationSecs: true, costCents: true, recordingUrl: true, endedAt: true,
          },
        })
      : [];
    const callById = new Map(calls.map((c) => [c.id, c]));

    const data = rows.map((r) => {
      const call = r.callId ? callById.get(r.callId) ?? null : null;
      return {
        contactId: r.contact.id,
        name: r.contact.name,
        phone: r.contact.phone,
        status: r.status,
        attempts: r.attempts,
        nextRetryAt: r.nextRetryAt,
        optedOutAt: r.contact.optedOutAt,
        updatedAt: r.updatedAt,
        callId: r.callId,
        callStatus: call?.status ?? null,
        outcome: call?.outcome ?? null,
        failReason: call?.failReason ?? null,
        durationSecs: call?.durationSecs ?? null,
        costCents: call?.costCents ?? null,
        recordingUrl: call?.recordingUrl ?? null,
        endedAt: call?.endedAt ?? null,
      };
    });

    return reply.send({ data, total, limit, offset });
  });

  // DELETE /v1/campaigns/:id/contacts/:contactId — retirar um contacto por tentar
  fastify.delete("/v1/campaigns/:id/contacts/:contactId", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id, contactId } = request.params as { id: string; contactId: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId }, select: { id: true, status: true } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (!CONTACT_EDITABLE_STATUSES.includes(campaign.status)) {
      return reply.status(400).send({ error: "Campaign is finished or cancelled" });
    }

    const cc = await prisma.campaignContact.findFirst({
      where: { campaignId: campaign.id, contactId },
      select: { id: true, status: true },
    });
    if (!cc) return reply.status(404).send({ error: "Contact is not in this campaign" });
    // Apagar um contacto já contactado perderia o histórico da chamada.
    if (cc.status !== "PENDING") {
      return reply.status(400).send({ error: "Only contacts that have not been called yet can be removed" });
    }

    await prisma.campaignContact.delete({ where: { id: cc.id } });
    const totalContacts = await syncTotalContacts(campaign.id);

    return reply.send({ ok: true, removed: 1, totalContacts });
  });

  // POST /v1/campaigns/:id/contacts/remove — remoção em lote
  fastify.post("/v1/campaigns/:id/contacts/remove", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { contactIds?: string[] };

    if (!Array.isArray(body.contactIds) || body.contactIds.length === 0 || body.contactIds.length > 5000) {
      return reply.status(400).send({ error: "contactIds must be a non-empty array of up to 5000 ids" });
    }

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId }, select: { id: true, status: true } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (!CONTACT_EDITABLE_STATUSES.includes(campaign.status)) {
      return reply.status(400).send({ error: "Campaign is finished or cancelled" });
    }

    const removable = await prisma.campaignContact.findMany({
      where: { campaignId: campaign.id, contactId: { in: body.contactIds }, status: "PENDING" },
      select: { id: true, contactId: true },
    });
    const removed = await prisma.campaignContact.deleteMany({ where: { id: { in: removable.map((r) => r.id) } } });
    const totalContacts = await syncTotalContacts(campaign.id);

    const removedIds = new Set(removable.map((r) => r.contactId));
    const skippedIds = body.contactIds.filter((cid) => !removedIds.has(cid));

    return reply.send({ removed: removed.count, skipped: skippedIds.length, skippedIds, totalContacts });
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
    emitWebhookAsync({
      tenantId,
      event: "campaign.paused",
      payload: { campaignId: campaign.id, reason: "manual", auto: false },
    });

    return reply.send({ ok: true, status: "PAUSED" });
  });

  // POST /v1/campaigns/:id/resume
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

  // POST /v1/campaigns/:id/cancel
  fastify.post("/v1/campaigns/:id/cancel", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (campaign.status === "DONE" || campaign.status === "CANCELLED") {
      return reply.status(400).send({ error: "Campaign already finished" });
    }

    // Quem ficou por tentar fica SKIPPED — não conta como insucesso.
    const [, skipped] = await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaign.id }, data: { status: "CANCELLED" } }),
      prisma.campaignContact.updateMany({
        where: { campaignId: campaign.id, status: { in: ["PENDING", "QUEUED"] } },
        data: { status: "SKIPPED" },
      }),
    ]);

    return reply.send({ ok: true, status: "CANCELLED", skippedContacts: skipped.count });
  });

  // GET /v1/campaigns/:id/report — números agregados da campanha
  fastify.get("/v1/campaigns/:id/report", { preHandler: [fastify.verifyScope("campaigns:read")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({
      where: { id, tenantId },
      select: { id: true, name: true, status: true, mode: true, createdAt: true },
    });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });

    const [callStats, contactStats, outcomes, answered] = await Promise.all([
      prisma.call.aggregate({
        where: { campaignId: campaign.id },
        _count: { id: true },
        _sum: { durationSecs: true, costCents: true },
        _avg: { durationSecs: true },
      }),
      prisma.campaignContact.groupBy({
        by: ["status"],
        where: { campaignId: campaign.id },
        _count: { status: true },
      }),
      prisma.call.groupBy({ by: ["outcome"], where: { campaignId: campaign.id }, _count: { id: true } }),
      prisma.call.count({ where: { campaignId: campaign.id, status: { in: ["COMPLETED", "ESCALATED"] } } }),
    ]);

    const byStatus = Object.fromEntries(contactStats.map((s) => [s.status, s._count.status])) as
      Record<string, number | undefined>;
    const n = (k: string): number => byStatus[k] ?? 0;

    return reply.send({
      campaign,
      contacts: {
        total: contactStats.reduce((sum, s) => sum + s._count.status, 0),
        pending: n("PENDING") + n("QUEUED") + n("IN_PROGRESS"),
        completed: n("COMPLETED"),
        failed: n("FAILED"),
        skipped: n("SKIPPED"),
        optedOut: n("OPTED_OUT"),
      },
      calls: {
        total: callStats._count.id,
        answered,
        totalDurationSecs: callStats._sum.durationSecs ?? 0,
        avgDurationSecs: Math.round(callStats._avg.durationSecs ?? 0),
        totalCostCents: callStats._sum.costCents ?? 0,
      },
      outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome ?? "unknown", o._count.id])),
    });
  });

  // DELETE /v1/campaigns/:id
  fastify.delete("/v1/campaigns/:id", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId }, select: { id: true, status: true } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    if (campaign.status === "RUNNING") {
      return reply.status(400).send({ error: "Pause or cancel the campaign before deleting it" });
    }

    // As chamadas ficam (histórico facturado); só se desliga da campanha.
    await prisma.$transaction([
      prisma.call.updateMany({ where: { campaignId: campaign.id }, data: { campaignId: null } }),
      prisma.campaignContact.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.campaign.delete({ where: { id: campaign.id } }),
    ]);

    return reply.send({ ok: true });
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
