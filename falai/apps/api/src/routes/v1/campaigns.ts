import type { FastifyInstance } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { enqueueWebhook } from "../../services/webhookDispatch.service.js";
import { normalizeAoPhone, INVALID_PHONE_MESSAGE as INVALID_PHONE } from "@falai/shared";

const REMOVABLE_STATUSES = ["PENDING", "QUEUED", "OPTED_OUT"] as const;

/** Estados em que ainda faz sentido mexer na lista de contactos da campanha. */
const CONTACT_EDITABLE_STATUSES = ["DRAFT", "SCHEDULED", "PAUSED", "RUNNING"];

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

    if (body.ttsVoiceId !== undefined) {
      const voiceCheck = await fastify.ttsVoices.assertKnownVoice(body.ttsVoiceId);
      if (!voiceCheck.ok) return reply.status(400).send({ error: voiceCheck.error });
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

  // POST /v1/campaigns/:id/contacts — põe contactos numa campanha DRAFT/SCHEDULED.
  //
  // Aceita duas formas de identificar quem entra:
  //
  //   { "contactIds": ["cm...", ...] }           ids já conhecidos
  //   { "contacts": [{ "phone": "923456789", "name": "...", "attributes": {...} }, ...] }
  //   { "phones": ["+244923456789", ...] }       atalho para o anterior, só números
  //
  // Com `contacts`/`phones` o cliente não precisa de saber ids nenhuns: quem
  // não existir na agenda é criado, quem já existir é reaproveitado (a chave
  // única é (tenantId, phone), portanto nunca se duplica ninguém), e em ambos
  // os casos o contacto entra na campanha. Era este o passo que obrigava a
  // encadear /v1/contacts/bulk + resolução de ids + este endpoint, e onde as
  // integrações se perdiam: o bulk devolvia "skipped" e ficavam sem o id.
  //
  // `name` e `attributes` são actualizados nos contactos que já existiam,
  // quando vêm no payload. Sem isto a segmentação (ex.: collectionStage) fica
  // congelada no primeiro carregamento e deixa de reflectir a realidade.
  fastify.post("/v1/campaigns/:id/contacts", { preHandler: [fastify.verifyScope("campaigns:write")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as {
      contactIds?: string[];
      contacts?: Array<{ phone?: string; name?: string; attributes?: Record<string, unknown> }>;
      phones?: string[];
      results?: boolean;
    };
    const query = request.query as { results?: string };
    const wantResults = body.results === true || query.results === "true";

    // `phones` é só açúcar sintáctico para `contacts`.
    type IncomingContact = { phone?: string; name?: string; attributes?: Record<string, unknown> };
    const incoming: IncomingContact[] | undefined =
      body.contacts ?? body.phones?.map((phone): IncomingContact => ({ phone }));
    const byPhone = incoming !== undefined;

    if (!byPhone && (!Array.isArray(body.contactIds) || body.contactIds.length === 0 || body.contactIds.length > 5000)) {
      return reply.status(400).send({
        error: "Provide contactIds (up to 5000 ids), or contacts/phones (up to 5000 phone numbers)",
      });
    }
    if (byPhone && (!Array.isArray(incoming) || incoming.length === 0 || incoming.length > 5000)) {
      return reply.status(400).send({ error: "contacts/phones must be a non-empty array of up to 5000 entries" });
    }

    const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!campaign) return reply.status(404).send({ error: "Campaign not found" });
    // Também com a campanha a decorrer: os novos contactos entram como PENDING.
    if (!CONTACT_EDITABLE_STATUSES.includes(campaign.status)) {
      return reply.status(400).send({ error: "Campaign is finished or cancelled — contacts cannot be added" });
    }

    type RowOutcome = "added" | "already_in_campaign" | "opted_out" | "duplicate_in_payload" | "invalid" | "not_found";
    const rows: Array<{ index: number; phone: string | null; contactId: string | null; outcome: RowOutcome; reason?: string }> = [];

    let eligible: Array<{ id: string }> = [];
    let createdContacts = 0;
    let skippedIds: string[] = [];

    if (byPhone) {
      // 1) Normalizar e desduplicar o payload.
      const seen = new Map<string, { phone: string; name: string | undefined; attributes: Record<string, unknown> | undefined }>();
      incoming!.forEach((c, index) => {
        if (!c || typeof c.phone !== "string" || !c.phone.trim()) {
          rows.push({ index, phone: null, contactId: null, outcome: "invalid", reason: "phone is required" });
          return;
        }
        const phone = normalizeAoPhone(c.phone);
        if (!phone) {
          rows.push({ index, phone: null, contactId: null, outcome: "invalid", reason: INVALID_PHONE });
          return;
        }
        if (seen.has(phone)) {
          rows.push({ index, phone, contactId: null, outcome: "duplicate_in_payload" });
          return;
        }
        seen.set(phone, { phone, name: c.name, attributes: c.attributes });
        rows.push({ index, phone, contactId: null, outcome: "added" });
      });

      const phones = [...seen.keys()];

      // 2) Criar só quem falta. Nunca se duplica: a chave única (tenantId, phone)
      //    garante-o, e o skipDuplicates absorve corridas com pedidos paralelos.
      if (phones.length) {
        const existing = new Set(
          (await prisma.contact.findMany({ where: { tenantId, phone: { in: phones } }, select: { phone: true } }))
            .map((c) => c.phone!) // filtrado por phone: { in }, nunca null
        );
        const toCreate = phones.filter((p) => !existing.has(p)).map((p) => {
          const e = seen.get(p)!;
          return {
            tenantId, phone: p,
            ...(e.name !== undefined && { name: e.name }),
            ...(e.attributes !== undefined && { attributes: e.attributes as Prisma.InputJsonValue }),
          };
        });
        if (toCreate.length) {
          createdContacts = (await prisma.contact.createMany({ data: toCreate, skipDuplicates: true })).count;
        }

        // 3) Refrescar nome/atributos de quem já existia e trouxe dados novos.
        const updates = [...existing]
          .map((p) => seen.get(p)!)
          .filter((e) => e.name !== undefined || e.attributes !== undefined);
        if (updates.length) {
          await prisma.$transaction(
            updates.map((e) =>
              prisma.contact.update({
                where: { tenantId_phone: { tenantId, phone: e.phone } },
                data: {
                  ...(e.name !== undefined && { name: e.name }),
                  ...(e.attributes !== undefined && { attributes: e.attributes as Prisma.InputJsonValue }),
                },
              })
            )
          );
        }
      }

      // 4) Recarregar todos, já com ids, e marcar os que estão em opt-out.
      const resolved = phones.length
        ? await prisma.contact.findMany({
            where: { tenantId, phone: { in: phones } },
            select: { id: true, phone: true, optedOutAt: true },
          })
        : [];
      const byPhoneMap = new Map(resolved.map((c) => [c.phone, c]));

      for (const r of rows) {
        if (r.outcome !== "added" || !r.phone) continue;
        const c = byPhoneMap.get(r.phone);
        if (!c) { r.outcome = "not_found"; continue; }
        r.contactId = c.id;
        if (c.optedOutAt) r.outcome = "opted_out";
      }
      eligible = resolved.filter((c) => !c.optedOutAt).map((c) => ({ id: c.id }));
    } else {
      const validContacts = await prisma.contact.findMany({
        where: { id: { in: body.contactIds! }, tenantId, optedOutAt: null },
        select: { id: true },
      });
      const validIds = new Set(validContacts.map((c) => c.id));
      skippedIds = body.contactIds!.filter((cid) => !validIds.has(cid));
      eligible = [...validIds].map((cid) => ({ id: cid }));
      body.contactIds!.forEach((cid, index) => {
        rows.push({
          index, phone: null, contactId: cid,
          outcome: validIds.has(cid) ? "added" : "not_found",
        });
      });
    }

    // Quem já estava na campanha não conta como novo. O createMany com
    // skipDuplicates trata do insert, mas precisamos de saber quem era para
    // o relatório por linha não dizer "added" a quem já lá estava.
    const alreadyIn = eligible.length
      ? new Set(
          (await prisma.campaignContact.findMany({
            where: { campaignId: campaign.id, contactId: { in: eligible.map((c) => c.id) } },
            select: { contactId: true },
          })).map((c) => c.contactId)
        )
      : new Set<string>();

    const created = await prisma.campaignContact.createMany({
      data: eligible.filter((c) => !alreadyIn.has(c.id)).map((c) => ({ campaignId: campaign.id, contactId: c.id })),
      skipDuplicates: true,
    });

    for (const r of rows) {
      if (r.outcome === "added" && r.contactId && alreadyIn.has(r.contactId)) r.outcome = "already_in_campaign";
    }

    // `totalContacts` alimenta o relatório e o launch; mantém-se coerente aqui
    // para não depender de a campanha ser lançada para ficar certo.
    const pending = await prisma.campaignContact.count({ where: { campaignId: campaign.id, status: "PENDING" } });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: pending } });

    const payload: Record<string, unknown> = {
      added: created.count,
      alreadyInCampaign: alreadyIn.size,
      contactsCreated: createdContacts,
      contactsReused: byPhone ? rows.filter((r) => r.contactId !== null).length - createdContacts : 0,
      optedOut: rows.filter((r) => r.outcome === "opted_out").length,
      invalid: rows.filter((r) => r.outcome === "invalid").map((r) => ({ index: r.index, reason: r.reason! })),
      duplicatesInPayload: rows.filter((r) => r.outcome === "duplicate_in_payload").length,
      received: byPhone ? incoming!.length : body.contactIds!.length,
      pendingContacts: pending,
      // Mantido para não quebrar quem já lê este campo na forma por contactIds.
      skipped: byPhone ? rows.filter((r) => r.outcome !== "added").length : skippedIds.length,
      ...(byPhone ? {} : { skippedIds }),
    };

    if (wantResults) payload.results = rows;

    return reply.send(payload);
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
