import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";

const scheduleSchema = z.object({
  // "NOW" ignora a janela: a campanha liga assim que for lançada. Sem isto, uma
  // campanha lançada fora do horário ficava parada sem explicação.
  mode: z.enum(["NOW", "WINDOW"]).default("WINDOW"),
  startHour: z.number().int().min(0).max(23).default(8),
  endHour: z.number().int().min(0).max(23).default(20),
  days: z.array(z.number().int().min(0).max(6)).optional(),
  // A janela é avaliada no fuso do cliente, não no do servidor.
  timezone: z.string().max(64).default("Africa/Luanda"),
});

const createSchema = z.object({
  name: z.string().min(2).max(150),
  mode: z.enum(["VOICE_AI", "FIXED_SCRIPT"]).default("VOICE_AI"),
  agentId: z.string().cuid().optional(),
  scriptText: z.string().min(10).max(2000).optional(),
  ttsVoiceId: z.string().max(100).optional(),
  schedule: scheduleSchema.optional(),
  retryPolicy: z
    .object({ maxAttempts: z.number().int().min(1).max(5), retryDelayMinutes: z.number().int().min(1) })
    .optional(),
  throttlePerMinute: z.number().int().min(1).max(100).default(2),
}).refine(
  (d) => d.mode === "FIXED_SCRIPT" ? !!d.scriptText : !!d.agentId,
  { message: "VOICE_AI requer agentId; FIXED_SCRIPT requer scriptText" }
);

const updateSchema = z.object({
  name: z.string().min(2).max(150).optional(),
  agentId: z.string().cuid().optional(),
  scriptText: z.string().min(10).max(2000).optional(),
  ttsVoiceId: z.string().max(100).optional(),
  schedule: scheduleSchema.optional(),
  retryPolicy: z
    .object({ maxAttempts: z.number().int().min(1).max(5), retryDelayMinutes: z.number().int().min(1) })
    .optional(),
  throttlePerMinute: z.number().int().min(1).max(100).optional(),
});

const addContactsSchema = z.object({
  contactIds: z.array(z.string().cuid()).min(1).max(5000),
});

export const tenantCampaignsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/campaigns
  fastify.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>(
    "/",
    { preHandler },
    async (request) => {
      const { tenantId } = request.tenantUser!;
      const { status, limit = "50", offset = "0" } = request.query;

      const campaigns = await prisma.campaign.findMany({
        where: {
          tenantId,
          ...(status && { status: status as import("@falai/db").CampaignStatus }),
        },
        orderBy: { createdAt: "desc" },
        take: parseInt(limit, 10),
        skip: parseInt(offset, 10),
        include: {
          agent: { select: { name: true } },
          _count: { select: { campaignContacts: true, calls: true } },
        },
      });

      const total = await prisma.campaign.count({
        where: {
          tenantId,
          ...(status && { status: status as import("@falai/db").CampaignStatus }),
        },
      });

      return { campaigns, total };
    }
  );

  // POST /tenant/campaigns
  fastify.post("/", { preHandler }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { tenantId, sub: userId } = request.tenantUser!;

    if (body.mode === "VOICE_AI" || !body.mode) {
      const agent = await prisma.agent.findFirst({
        where: { id: body.agentId!, tenantId, status: "ACTIVE", deletedAt: null },
      });
      if (!agent) return reply.status(400).send({ error: "Agente não encontrado ou não está activo" });
    }

    const campaign = await prisma.campaign.create({
      data: {
        tenantId,
        mode: body.mode,
        ...(body.agentId && { agentId: body.agentId }),
        ...(body.scriptText !== undefined && { scriptText: body.scriptText }),
        ...(body.ttsVoiceId !== undefined && { ttsVoiceId: body.ttsVoiceId }),
        name: body.name,
        throttlePerMinute: body.throttlePerMinute,
        ...(body.schedule !== undefined && { scheduleJson: body.schedule as object }),
        ...(body.retryPolicy !== undefined && { retryPolicy: body.retryPolicy as object }),
      },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "campaign.created",
      targetType: "Campaign",
      targetId: campaign.id,
      after: { name: campaign.name, agentId: campaign.agentId } as object,
      ip: request.ip,
    });

    return reply.status(201).send({ campaign });
  });

  // GET /tenant/campaigns/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({
      where: { id: request.params.id, tenantId },
      include: {
        agent: { select: { id: true, name: true } },
        _count: { select: { campaignContacts: true, calls: true } },
      },
    });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });

    const statusBreakdown = await prisma.campaignContact.groupBy({
      by: ["status"],
      where: { campaignId: campaign.id },
      _count: { status: true },
    });

    return { campaign, statusBreakdown };
  });

  // PATCH /tenant/campaigns/:id
  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const body = updateSchema.parse(request.body);
    const { tenantId } = request.tenantUser!;

    const existing = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (!["DRAFT", "SCHEDULED"].includes(existing.status)) {
      return reply.status(400).send({ error: "Campanha em curso não pode ser editada. Pausa primeiro." });
    }

    const campaign = await prisma.campaign.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.agentId !== undefined && { agentId: body.agentId }),
        ...(body.scriptText !== undefined && { scriptText: body.scriptText }),
        ...(body.ttsVoiceId !== undefined && { ttsVoiceId: body.ttsVoiceId }),
        ...(body.throttlePerMinute !== undefined && { throttlePerMinute: body.throttlePerMinute }),
        ...(body.schedule !== undefined && { scheduleJson: body.schedule as object }),
        ...(body.retryPolicy !== undefined && { retryPolicy: body.retryPolicy as object }),
      },
    });

    return { campaign };
  });

  // POST /tenant/campaigns/:id/start
  fastify.post<{ Params: { id: string } }>("/:id/start", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (!["DRAFT", "SCHEDULED", "PAUSED"].includes(campaign.status)) {
      return reply.status(400).send({ error: `Campanha não pode ser iniciada a partir do estado ${campaign.status}` });
    }

    const pendingCount = await prisma.campaignContact.count({
      where: { campaignId: campaign.id, status: "PENDING" },
    });
    if (pendingCount === 0) {
      return reply.status(400).send({ error: "Campanha sem contactos pendentes. Adiciona contactos primeiro." });
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "RUNNING", totalContacts: pendingCount },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "campaign.started",
      targetType: "Campaign",
      targetId: campaign.id,
      ip: request.ip,
    });

    return { ok: true, status: "RUNNING", pendingContacts: pendingCount };
  });

  // POST /tenant/campaigns/:id/launch — inicia + dispara imediatamente (sem esperar pelo tick de 30s)
  fastify.post<{ Params: { id: string } }>("/:id/launch", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (!["DRAFT", "SCHEDULED", "PAUSED"].includes(campaign.status)) {
      return reply.status(400).send({ error: `Campanha não pode ser lançada a partir do estado ${campaign.status}` });
    }

    const pendingCount = await prisma.campaignContact.count({
      where: { campaignId: campaign.id, status: "PENDING" },
    });
    if (pendingCount === 0) {
      return reply.status(400).send({ error: "Campanha sem contactos pendentes. Adiciona contactos primeiro." });
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "RUNNING", totalContacts: pendingCount },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "campaign.launched",
      targetType: "Campaign",
      targetId: campaign.id,
      ip: request.ip,
    });

    // Disparo imediato — não espera resposta para não bloquear o cliente
    fastify.campaignDispatcher.processNow(campaign.id).catch((err) =>
      fastify.log.error({ err, campaignId: campaign.id }, "campaign.launch.dispatch_error")
    );

    return { ok: true, status: "RUNNING", pendingContacts: pendingCount };
  });

  // POST /tenant/campaigns/:id/pause
  fastify.post<{ Params: { id: string } }>("/:id/pause", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (campaign.status !== "RUNNING") {
      return reply.status(400).send({ error: "Apenas campanhas RUNNING podem ser pausadas" });
    }

    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "campaign.paused",
      targetType: "Campaign",
      targetId: campaign.id,
      ip: request.ip,
    });

    return { ok: true, status: "PAUSED" };
  });

  // POST /tenant/campaigns/:id/resume
  fastify.post<{ Params: { id: string } }>("/:id/resume", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (campaign.status !== "PAUSED") {
      return reply.status(400).send({ error: "Apenas campanhas PAUSED podem ser retomadas" });
    }

    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "RUNNING" } });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "campaign.resumed",
      targetType: "Campaign",
      targetId: campaign.id,
      ip: request.ip,
    });

    return { ok: true, status: "RUNNING" };
  });

  // POST /tenant/campaigns/:id/cancel
  fastify.post<{ Params: { id: string } }>("/:id/cancel", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (campaign.status === "DONE" || campaign.status === "CANCELLED") {
      return reply.status(400).send({ error: "Campanha já terminada" });
    }

    await prisma.$transaction([
      prisma.campaign.update({ where: { id: campaign.id }, data: { status: "CANCELLED" } }),
      // Mark all PENDING contacts as SKIPPED
      prisma.campaignContact.updateMany({
        where: { campaignId: campaign.id, status: "PENDING" },
        data: { status: "FAILED" },
      }),
    ]);

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "campaign.cancelled",
      targetType: "Campaign",
      targetId: campaign.id,
      ip: request.ip,
    });

    return { ok: true, status: "CANCELLED" };
  });

  // POST /tenant/campaigns/:id/retry — reset contacts e relança campanha
  fastify.post<{ Params: { id: string } }>("/:id/retry", { preHandler }, async (request, reply) => {
    const { tenantId, sub: userId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (!["CANCELLED", "DONE"].includes(campaign.status)) {
      return reply.status(400).send({ error: "Só é possível repetir campanhas CANCELLED ou DONE" });
    }

    // Reset all contacts back to PENDING (including FAILED ones from cancel)
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id },
      data: { status: "PENDING" },
    });

    const totalContacts = await prisma.campaignContact.count({ where: { campaignId: campaign.id } });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "RUNNING",
        completed: 0,
        failedCount: 0,
        totalContacts,
        summary: null,
      },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "campaign.retried",
      targetType: "Campaign",
      targetId: campaign.id,
      ip: request.ip,
    });

    // Disparo imediato
    fastify.campaignDispatcher.processNow(campaign.id).catch((err) =>
      fastify.log.error({ err, campaignId: campaign.id }, "campaign.retry.dispatch_error")
    );

    return { ok: true, status: "RUNNING", totalContacts };
  });

  // POST /tenant/campaigns/:id/contacts — add existing contacts to campaign
  fastify.post<{ Params: { id: string } }>("/:id/contacts", { preHandler }, async (request, reply) => {
    const body = addContactsSchema.parse(request.body);
    const { tenantId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({ where: { id: request.params.id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    if (!["DRAFT", "SCHEDULED"].includes(campaign.status)) {
      return reply.status(400).send({ error: "Só é possível adicionar contactos a campanhas DRAFT ou SCHEDULED" });
    }

    // Verify all contacts belong to this tenant
    const validContacts = await prisma.contact.findMany({
      where: { id: { in: body.contactIds }, tenantId, optedOutAt: null },
      select: { id: true },
    });

    const validIds = new Set(validContacts.map((c) => c.id));
    const skipped = body.contactIds.filter((id) => !validIds.has(id));

    // Batch upsert CampaignContacts
    const created = await prisma.campaignContact.createMany({
      data: [...validIds].map((contactId) => ({ campaignId: campaign.id, contactId })),
      skipDuplicates: true,
    });

    return {
      added: created.count,
      skipped: skipped.length,
      skippedIds: skipped,
    };
  });

  // GET /tenant/campaigns/:id/report
  fastify.get<{ Params: { id: string } }>("/:id/report", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const campaign = await prisma.campaign.findFirst({
      where: { id: request.params.id, tenantId },
      include: { agent: { select: { name: true } } },
    });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });

    // Aggregate stats
    const [callStats, contactStats] = await Promise.all([
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
    ]);

    const outcomeBreakdown = await prisma.call.groupBy({
      by: ["outcome"],
      where: { campaignId: campaign.id },
      _count: { id: true },
    });

    const answeredCount = await prisma.call.count({
      where: { campaignId: campaign.id, status: { in: ["COMPLETED", "ESCALATED"] } },
    });

    // Generate LLM summary if not already cached.
    // Em modo stub o LLM devolve respostas de conversa (não IA real), por isso não geramos
    // resumo — o CRM esconde a secção quando summary é null.
    let summary = campaign.summary;
    if (!summary && !fastify.llmStub && callStats._count.id > 0) {
      try {
        const reportText = buildReportText(campaign.name, callStats, contactStats, outcomeBreakdown);
        const result = await fastify.callEngine.simulateTurn({
          userText: reportText,
          systemPrompt:
            "Você é um analista de campanhas de voz. Gera um resumo executivo conciso (3-5 frases) dos resultados abaixo, em português angolano. Inclui: taxa de sucesso, custo total, principais observações e recomendações.",
          history: [],
          variables: {},
        });
        summary = result.reply;
        await prisma.campaign.update({ where: { id: campaign.id }, data: { summary } });
      } catch {
        summary = null; // non-critical
      }
    }

    // Flat Campaign-shaped payload the CRM detail page consumes, plus report extras.
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      agentId: campaign.agentId,
      agent: campaign.agent,
      totalContacts: campaign.totalContacts,
      completedCount: campaign.completed,
      failedCount: campaign.failedCount,
      answeredCount,
      pendingCount: Math.max(0, campaign.totalContacts - campaign.completed - campaign.failedCount),
      estimatedCostCents: null,
      actualCostCents: callStats._sum.costCents ?? 0,
      scheduleJson: campaign.scheduleJson,
      retryPolicy: campaign.retryPolicy,
      throttlePerMinute: campaign.throttlePerMinute,
      summary,
      startedAt: null,
      completedAt: null,
      createdAt: campaign.createdAt,
      report: {
        calls: {
          total: callStats._count.id,
          totalDurationSecs: callStats._sum.durationSecs ?? 0,
          avgDurationSecs: Math.round(callStats._avg.durationSecs ?? 0),
          totalCostCents: callStats._sum.costCents ?? 0,
        },
        contactStatuses: Object.fromEntries(contactStats.map((s) => [s.status, s._count.status])),
        outcomes: Object.fromEntries(outcomeBreakdown.map((o) => [o.outcome ?? "unknown", o._count.id])),
      },
    };
  });
};

function buildReportText(
  name: string,
  callStats: { _count: { id: number }; _sum: { durationSecs: number | null; costCents: number | null }; _avg: { durationSecs: number | null } },
  contactStats: Array<{ status: string; _count: { status: number } }>,
  outcomes: Array<{ outcome: string | null; _count: { id: number } }>
): string {
  const lines = [
    `Campanha: ${name}`,
    `Total de chamadas: ${callStats._count.id}`,
    `Duração total: ${Math.round((callStats._sum.durationSecs ?? 0) / 60)} minutos`,
    `Custo total: ${((callStats._sum.costCents ?? 0) / 100).toFixed(2)} Kz`,
    `Duração média: ${Math.round(callStats._avg.durationSecs ?? 0)}s`,
    ``,
    `Estados dos contactos:`,
    ...contactStats.map((s) => `  ${s.status}: ${s._count.status}`),
    ``,
    `Resultados das chamadas:`,
    ...outcomes.map((o) => `  ${o.outcome ?? "sem resultado"}: ${o._count.id}`),
  ];
  return lines.join("\n");
}
