import type { FastifyPluginAsync } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { z } from "zod";
import { YeastarAdapter } from "@falai/providers";
import { reserveBalance, computeReservation, effectiveBillingMode } from "../../services/billing.service.js";
import { getTenantTelephony } from "../../services/tenantTelephony.service.js";
import { resolveOutboundExtension, NoOutboundLineError } from "../../services/outboundExtension.service.js";
import { ensureCdrSynced, mapPbxCall, PBX_CALL_SELECT, activeInboundCalls } from "../../services/pbxCdr.service.js";

const createSchema = z.object({
  agentId: z.string().min(1),
  to: z.string().min(3),
  variables: z.record(z.string()).optional(),
  // Scheduling is accepted for forward-compat but not yet persisted (no schema column).
  scheduledAt: z.string().optional(),
});

const directCallSchema = z.object({
  fromExtension: z.string().min(1),
  to: z.string().min(3),
});

const hangupSchema = z.object({
  providerCallId: z.string().min(1),
});

// Map a Prisma call row (with agent/contact relations) to the CRM Call shape.
type CallRow = {
  id: string;
  agentId: string | null;
  kind?: string;
  contactId: string | null;
  toNumber: string;
  fromNumber?: string | null;
  status: string;
  outcome: string | null;
  durationSecs: number;
  costCents: number;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  recordingUrl?: string | null;
  variables?: unknown;
  agent?: { name: string } | null;
  contact?: { name: string | null } | null;
  turns?: {
    id: string;
    seq: number;
    role: "AGENT" | "HUMAN" | "SYSTEM";
    text: string;
    sttMs: number | null;
    llmMs: number | null;
    ttsMs: number | null;
    createdAt: Date;
  }[];
};

function mapCall(c: CallRow) {
  const direction = c.kind === "INBOUND" ? "inbound" : "outbound";
  return {
    id: c.id,
    agentId: c.agentId,
    kind: c.kind ?? "AI_AGENT",
    direction,
    contactId: c.contactId,
    to: c.toNumber,
    from: c.fromNumber ?? null,
    // Número do interveniente externo (entrada → origem; saída → destino)
    party: direction === "inbound" ? c.fromNumber ?? c.toNumber : c.toNumber,
    status: c.status,
    outcome: c.outcome,
    durationSecs: c.durationSecs,
    costCents: c.costCents,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    createdAt: c.createdAt,
    recordingUrl: c.recordingUrl ?? null,
    agent: c.agent ?? { name: "" },
    contact: c.contact ? { name: c.contact.name ?? "" } : null,
    ...(c.variables !== undefined && { variables: c.variables }),
    ...(c.turns && {
      turns: c.turns.map((t) => ({
        id: t.id,
        seq: t.seq,
        role: t.role === "AGENT" ? "agent" : "user",
        text: t.text,
        sttMs: t.sttMs,
        llmMs: t.llmMs,
        ttsMs: t.ttsMs,
        createdAt: t.createdAt,
      })),
    }),
  };
}

export const tenantCallsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/calls — paginated list
  fastify.get<{ Querystring: { status?: string; agentId?: string; campaignId?: string; limit?: string; offset?: string } }>(
    "/",
    { preHandler },
    async (request) => {
      const { tenantId } = request.tenantUser!;
      const { status, agentId, campaignId, limit = "50", offset = "0" } = request.query;

      // Tenants CRM (BYO-PBX): a lista vem do CDR do PBX do cliente, não da tabela Call
      const { isCrmPbx } = await ensureCdrSynced(fastify, tenantId);
      if (isCrmPbx) {
        const take = parseInt(limit, 10);
        const skip = parseInt(offset, 10);
        const [rows, total, liveRows] = await Promise.all([
          prisma.pbxCall.findMany({
            where: { tenantId },
            orderBy: { startedAt: "desc" },
            take,
            skip,
            select: PBX_CALL_SELECT,
          }),
          prisma.pbxCall.count({ where: { tenantId } }),
          // Chamadas de entrada em curso ainda sem CDR — só na 1ª página e sem filtro de estado
          skip === 0 && !status ? activeInboundCalls(tenantId) : Promise.resolve([]),
        ]);
        const live = liveRows.map(mapCall);
        return { calls: [...live, ...rows.map(mapPbxCall)], total: total + live.length };
      }

      const where: Prisma.CallWhereInput = { tenantId };
      if (status) where.status = status as import("@falai/db").CallStatus;
      if (agentId) where.agentId = agentId;
      if (campaignId) where.campaignId = campaignId;

      const [calls, total] = await Promise.all([
        prisma.call.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
          select: {
            id: true, agentId: true, kind: true, contactId: true, toNumber: true, fromNumber: true, status: true,
            outcome: true, durationSecs: true, costCents: true,
            startedAt: true, endedAt: true, createdAt: true,
            agent: { select: { name: true } },
            contact: { select: { name: true } },
          },
        }),
        prisma.call.count({ where }),
      ]);

      return { calls: calls.map(mapCall), total };
    },
  );

  // GET /tenant/calls/:id — detail with transcript turns
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const call = await prisma.call.findFirst({
      where: { id: request.params.id, tenantId },
      select: {
        id: true, agentId: true, kind: true, contactId: true, toNumber: true, fromNumber: true, status: true,
        outcome: true, durationSecs: true, costCents: true, variables: true, recordingUrl: true,
        startedAt: true, endedAt: true, createdAt: true,
        agent: { select: { name: true } },
        contact: { select: { name: true } },
        turns: {
          orderBy: { seq: "asc" },
          select: { id: true, seq: true, role: true, text: true, sttMs: true, llmMs: true, ttsMs: true, createdAt: true },
        },
      },
    });
    if (call) return { call: mapCall(call) };

    // Fallback: chamada do PBX (produto CRM BYO-PBX) — sem turnos de IA
    const pbxCall = await prisma.pbxCall.findFirst({
      where: { id: request.params.id, tenantId },
      select: PBX_CALL_SELECT,
    });
    if (pbxCall) return { call: mapPbxCall(pbxCall) };

    return reply.status(404).send({ error: "Chamada não encontrada" });
  });

  // POST /tenant/calls — place an outbound call now
  fastify.post("/", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = createSchema.parse(request.body);

    const [agent, tenant] = await Promise.all([
      prisma.agent.findFirst({
        where: { id: body.agentId, tenantId, deletedAt: null },
        select: { id: true, status: true, systemPrompt: true, ttsVoiceId: true, maxCallSeconds: true, maxTurnSeconds: true, escalationNumber: true },
      }),
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          billingModeOverride: true,
          plan: { select: { billingMode: true, pricePerMinuteCents: true, pricePerCallCents: true, aiAgentsEnabled: true } },
        },
      }),
    ]);

    if (tenant && !tenant.plan.aiAgentsEnabled) {
      return reply.status(403).send({ error: "O plano actual não inclui agentes de IA" });
    }

    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status !== "ACTIVE") return reply.status(422).send({ error: "O agente tem de estar ACTIVO para fazer chamadas" });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    // Resolve a extensão de saída da linha do cliente (antes de reservar saldo)
    let fromExtension: string;
    try {
      fromExtension = await resolveOutboundExtension(tenantId);
    } catch (err) {
      if (err instanceof NoOutboundLineError) {
        return reply.status(422).send({ error: "O cliente não tem nenhuma linha de saída activa. Configure uma linha no backoffice." });
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
    if (!reserved) return reply.status(402).send({ error: "Saldo insuficiente" });

    const call = await prisma.call.create({
      data: {
        tenantId,
        agentId: body.agentId,
        toNumber: body.to,
        ...(body.variables !== undefined && { variables: body.variables as Prisma.InputJsonValue }),
        status: "DIALING",
        startedAt: new Date(),
      },
      select: {
        id: true, agentId: true, contactId: true, toNumber: true, fromNumber: true, status: true,
        outcome: true, durationSecs: true, costCents: true, startedAt: true, endedAt: true, createdAt: true,
        agent: { select: { name: true } },
        contact: { select: { name: true } },
      },
    });

    let providerCallId: string;
    try {
      const result = await (fastify.yeastar as YeastarAdapter).dial({
        fromExtension,
        to: body.to,
        ref: call.id,
      });
      providerCallId = result.providerCallId;
      await prisma.call.update({ where: { id: call.id }, data: { yeastarCallId: providerCallId } });
    } catch (err) {
      await Promise.all([
        prisma.$executeRaw`UPDATE "Tenant" SET "balanceCents" = "balanceCents" + ${estimatedCents} WHERE id = ${tenantId}`,
        prisma.call.update({ where: { id: call.id }, data: { status: "FAILED", failReason: "Dial error" } }),
      ]);
      fastify.log.error({ err }, "tenant.calls.dial_failed");
      return reply.status(502).send({ error: "Não foi possível iniciar a chamada" });
    }

    await fastify.callEngine.registerCall({
      callId: call.id,
      agentId: body.agentId,
      tenantId,
      toNumber: body.to,
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

    return reply.status(202).send({ call: mapCall(call) });
  });

  // POST /tenant/calls/:id/cancel — hang up a call still in progress
  fastify.post<{ Params: { id: string } }>("/:id/cancel", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const existing = await prisma.call.findFirst({
      where: { id: request.params.id, tenantId },
      select: { id: true, status: true, yeastarCallId: true },
    });
    if (!existing) return reply.status(404).send({ error: "Chamada não encontrada" });

    const cancellable = ["QUEUED", "DIALING", "RINGING", "IN_PROGRESS"];
    if (!cancellable.includes(existing.status)) {
      return reply.status(400).send({ error: "Esta chamada já não pode ser cancelada" });
    }

    if (existing.yeastarCallId) {
      try {
        await (fastify.yeastar as YeastarAdapter).hangup(existing.yeastarCallId);
      } catch (err) {
        fastify.log.warn({ err }, "tenant.calls.cancel_hangup_failed");
      }
    }

    const call = await prisma.call.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", endedAt: new Date() },
      select: {
        id: true, agentId: true, contactId: true, toNumber: true, fromNumber: true, status: true,
        outcome: true, durationSecs: true, costCents: true, startedAt: true, endedAt: true, createdAt: true,
        agent: { select: { name: true } },
        contact: { select: { name: true } },
      },
    });

    return { call: mapCall(call) };
  });

  // ── Chamadas directas (click-to-call, sem agente/IA) ──────────────────────

  // GET /tenant/calls/extensions — lista as linhas do próprio cliente para o dropdown
  // (não expõe extensões de outros clientes no PBX partilhado)
  fastify.get("/extensions", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const lines = await prisma.tenantLine.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { extension: true, name: true },
    });
    return { extensions: lines.map((l) => ({ number: l.extension, name: l.name })) };
  });

  // GET /tenant/calls/direct/status/:callId — verifica se uma chamada directa ainda está activa no PBX
  fastify.get<{ Params: { callId: string } }>("/direct/status/:callId", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    try {
      const telephony = await getTenantTelephony(fastify, tenantId);
      const active = await (telephony as YeastarAdapter).isCallActive(request.params.callId);
      return { active };
    } catch (err) {
      fastify.log.warn({ err }, "tenant.calls.direct_status_failed");
      return reply.status(502).send({ error: "Não foi possível verificar o estado da chamada" });
    }
  });

  // POST /tenant/calls/direct — origina uma chamada normal (extensão → número), sem agente
  fastify.post("/direct", { preHandler }, async (request, reply) => {
    const body = directCallSchema.parse(request.body);
    const admin = request.tenantUser!;
    const { tenantId } = admin;

    // A extensão de origem tem de ser uma linha activa deste cliente
    const ownLine = await prisma.tenantLine.findFirst({
      where: { tenantId, isActive: true, extension: body.fromExtension },
      select: { id: true },
    });
    if (!ownLine) {
      return reply.status(422).send({ error: "Extensão de origem inválida — não pertence a nenhuma linha activa deste cliente." });
    }

    fastify.log.info({ action: "direct_call.initiated", from: body.fromExtension, to: body.to, tenantId });

    try {
      const telephony = await getTenantTelephony(fastify, tenantId);
      const result = await telephony.dial({
        fromExtension: body.fromExtension,
        to: body.to,
        ref: `direct_${Date.now()}`,
        autoAnswer: "no",
      });

      // Persiste no histórico do CRM para aparecer na lista de chamadas
      prisma.call
        .create({
          data: {
            tenantId,
            kind: "DIRECT",
            toNumber: body.to,
            status: "IN_PROGRESS",
            startedAt: new Date(),
            yeastarCallId: result.providerCallId,
          },
          select: { id: true },
        })
        .catch((err: unknown) => fastify.log.error({ err, tenantId }, "direct_call.persist_failed"));

      return reply.status(202).send({ providerCallId: result.providerCallId, from: body.fromExtension, to: body.to });
    } catch (err) {
      fastify.log.error({ err }, "tenant.calls.direct_dial_failed");
      return reply.status(502).send({ error: "Não foi possível iniciar a chamada. Verifica a extensão e o número." });
    }
  });

  // POST /tenant/calls/direct/hangup — desliga uma chamada directa pelo providerCallId
  fastify.post("/direct/hangup", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = hangupSchema.parse(request.body);
    try {
      const telephony = await getTenantTelephony(fastify, tenantId);
      await telephony.hangup(body.providerCallId);

      // Fecha o registo da chamada directa (fire-and-forget)
      prisma.call
        .updateMany({
          where: { tenantId, yeastarCallId: body.providerCallId, kind: "DIRECT", status: "IN_PROGRESS" },
          data: { status: "COMPLETED", endedAt: new Date() },
        })
        .catch((err: unknown) => fastify.log.warn({ err }, "direct_call.close_failed"));

      return { ok: true };
    } catch (err) {
      fastify.log.warn({ err }, "tenant.calls.direct_hangup_failed");
      return reply.status(502).send({ error: "Não foi possível desligar a chamada" });
    }
  });
};
