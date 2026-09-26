import type { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { prisma, type Prisma } from "@falai/db";
import { z } from "zod";
import { recordingSettings } from "../../services/callRecording.service.js";
import { YeastarAdapter } from "@falai/providers";
import { reserveBalance, computeReservation, effectivePrice } from "../../services/billing.service.js";
import { getTenantTelephony, getTenantAsterisk } from "../../services/tenantTelephony.service.js";
import {
  startAsteriskDirectCall,
  hangupAsteriskDirectCall,
  isAsteriskDirectCallActive,
  DirectCallError,
} from "../../services/directCall.service.js";
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
  failReason?: string | null;
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

/** Tipo de conteúdo da gravação, pela extensão com que foi gravada. */
function recordingContentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".ogg": return "audio/ogg";
    case ".wav": case ".wav49": return "audio/wav";
    case ".gsm": return "audio/x-gsm";
    case ".g722": return "audio/G722";
    case ".alaw": case ".ulaw": return "audio/basic";
    default: return "application/octet-stream";
  }
}

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
    failReason: c.failReason ?? null,
    durationSecs: c.durationSecs,
    costCents: c.costCents,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    createdAt: c.createdAt,
    // Nunca se devolve o caminho do ficheiro: o que o cliente recebe é a rota
    // que o serve, já autenticada e com o dono da chamada validado.
    recordingUrl: c.recordingUrl ? `/tenant/calls/${c.id}/recording` : null,
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
            outcome: true, failReason: true, durationSecs: true, costCents: true,
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
        outcome: true, failReason: true, durationSecs: true, costCents: true, variables: true, recordingUrl: true,
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

  /**
   * GET /tenant/calls/:id/recording — devolve o áudio da gravação.
   *
   * O ficheiro vive fora da árvore pública de propósito: uma gravação é das
   * coisas mais sensíveis que a plataforma guarda, por isso passa por aqui,
   * onde se confirma que a chamada é mesmo deste cliente.
   */
  fastify.get<{ Params: { id: string } }>("/:id/recording", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const call = await prisma.call.findFirst({
      where: { id: request.params.id, tenantId },
      select: { recordingUrl: true },
    });
    if (!call?.recordingUrl) return reply.status(404).send({ error: "Gravação não encontrada" });

    const { dir } = await recordingSettings();
    if (!dir) return reply.status(503).send({ error: "Pasta de gravações não configurada" });

    // O caminho vem da nossa base de dados, mas confirma-se na mesma que cai
    // dentro da pasta de gravações: um valor estragado não pode virar uma forma
    // de ler ficheiros do servidor.
    const base = resolve(dir);
    const file = resolve(base, call.recordingUrl);
    if (file !== base && !file.startsWith(base + sep)) {
      request.log.error({ callId: request.params.id }, "call_recording.path_outside_dir");
      return reply.status(404).send({ error: "Gravação não encontrada" });
    }

    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      // A linha diz que há gravação mas o ficheiro não está lá (apagado à mão,
      // pasta trocada, purga). Não é erro do servidor — é uma gravação que
      // deixou de existir.
      request.log.warn({ callId: request.params.id, file }, "call_recording.file_missing");
      return reply.status(404).send({ error: "Gravação não encontrada" });
    }

    return reply
      .type(recordingContentType(call.recordingUrl))
      .header("Content-Length", size)
      .header("Cache-Control", "private, no-store")
      .send(createReadStream(file));
  });

  // POST /tenant/calls — place an outbound call now
  fastify.post("/", { preHandler, config: { feature: "agents" } }, async (request, reply) => {
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
          billingModeOverride: true, pricePerMinuteOverrideCents: true,
          plan: { select: { billingMode: true, pricePerMinuteCents: true, pricePerCallCents: true, aiAgentsEnabled: true } },
        },
      }),
    ]);

    if (tenant && !tenant.plan.aiAgentsEnabled) {
      return reply.status(403).send({ error: "O plano actual não inclui agentes de IA" });
    }

    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (!agent.ttsVoiceId) return reply.status(422).send({ error: "Agente sem voz — só serve canais de texto" });
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

    const price = effectivePrice(tenant);
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
        outcome: true, failReason: true, durationSecs: true, costCents: true, startedAt: true, endedAt: true, createdAt: true,
        agent: { select: { name: true } },
        contact: { select: { name: true } },
      },
    });

    let providerCallId: string;
    try {
      const result = await fastify.telephony.dial({
        fromExtension,
        to: body.to,
        ref: call.id,
        tenantId,
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
  fastify.post<{ Params: { id: string } }>("/:id/cancel", { preHandler, config: { feature: "agents" } }, async (request, reply) => {
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
        await fastify.telephony.hangup(existing.yeastarCallId);
      } catch (err) {
        fastify.log.warn({ err }, "tenant.calls.cancel_hangup_failed");
      }
    }

    const call = await prisma.call.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", endedAt: new Date() },
      select: {
        id: true, agentId: true, contactId: true, toNumber: true, fromNumber: true, status: true,
        outcome: true, failReason: true, durationSecs: true, costCents: true, startedAt: true, endedAt: true, createdAt: true,
        agent: { select: { name: true } },
        contact: { select: { name: true } },
      },
    });

    return { call: mapCall(call) };
  });

  // ── Chamadas directas (click-to-call, sem agente/IA) ──────────────────────

  // GET /tenant/calls/extensions — extensões do próprio cliente para o dropdown
  // (não expõe extensões de outros clientes no PBX partilhado). Fonte: modelo
  // Extension; TenantLine só para quem ainda não tem extensões (compat §6).
  fastify.get("/extensions", { preHandler, config: { feature: "directCall" } }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const exts = await prisma.extension.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { number: "asc" }],
      select: { number: true, displayName: true },
    });
    if (exts.length > 0) return { extensions: exts.map((e) => ({ number: e.number, name: e.displayName ?? e.number })) };
    const lines = await prisma.tenantLine.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { extension: true, name: true },
    });
    return { extensions: lines.map((l) => ({ number: l.extension, name: l.name })) };
  });

  // GET /tenant/calls/direct/status/:callId — verifica se uma chamada directa ainda está activa no PBX
  fastify.get<{ Params: { callId: string } }>("/direct/status/:callId", { preHandler, config: { feature: "directCall" } }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    try {
      if (await getTenantAsterisk(fastify, tenantId)) {
        return { active: isAsteriskDirectCallActive(request.params.callId) };
      }
      const telephony = await getTenantTelephony(fastify, tenantId);
      const active = await (telephony as YeastarAdapter).isCallActive(request.params.callId);
      return { active };
    } catch (err) {
      fastify.log.warn({ err }, "tenant.calls.direct_status_failed");
      return reply.status(502).send({ error: "Não foi possível verificar o estado da chamada" });
    }
  });

  // POST /tenant/calls/direct — origina uma chamada normal (extensão → número), sem agente
  fastify.post("/direct", { preHandler, config: { feature: "directCall" } }, async (request, reply) => {
    const body = directCallSchema.parse(request.body);
    const admin = request.tenantUser!;
    const { tenantId } = admin;

    // A extensão de origem tem de ser uma extensão (ou linha antiga) activa deste cliente
    const ownLine =
      (await prisma.extension.findFirst({
        where: { tenantId, isActive: true, number: body.fromExtension },
        select: { id: true },
      })) ??
      (await prisma.tenantLine.findFirst({
        where: { tenantId, isActive: true, extension: body.fromExtension },
        select: { id: true },
      }));
    if (!ownLine) {
      return reply.status(422).send({ error: "Extensão de origem inválida — não pertence a nenhuma linha activa deste cliente." });
    }

    fastify.log.info({ action: "direct_call.initiated", from: body.fromExtension, to: body.to, tenantId });

    try {
      const ref = `direct_${Date.now()}`;
      // Com o motor próprio ligado a chamada TEM de sair pelo nosso Asterisk.
      // Antes ia sempre por getTenantTelephony() (Yeastar), o que a mandava
      // para um PBX externo e o telemóvel nunca tocava — ver
      // services/directCall.service.ts.
      // Só os tenants SEM PBX próprio vão pelo nosso Asterisk — ver
      // getTenantAsterisk(). Usar fastify.asterisk directamente atropelava a
      // escolha por tenant.
      const asterisk = await getTenantAsterisk(fastify, tenantId);
      const result = asterisk
        ? await startAsteriskDirectCall({
            asterisk,
            tenantId,
            fromExtension: body.fromExtension,
            to: body.to,
            ref,
            fastify,
            log: fastify.log,
          })
        : await (await getTenantTelephony(fastify, tenantId)).dial({
            fromExtension: body.fromExtension,
            to: body.to,
            ref,
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
      // Extensão sem telefone registado / inexistente é erro de quem pede, e a
      // mensagem concreta poupa uma ida ao log.
      if (err instanceof DirectCallError) return reply.status(422).send({ error: err.message });
      return reply.status(502).send({ error: "Não foi possível iniciar a chamada. Verifica a extensão e o número." });
    }
  });

  // POST /tenant/calls/direct/hangup — desliga uma chamada directa pelo providerCallId
  fastify.post("/direct/hangup", { preHandler, config: { feature: "directCall" } }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = hangupSchema.parse(request.body);
    try {
      const asterisk = await getTenantAsterisk(fastify, tenantId);
      if (asterisk) {
        await hangupAsteriskDirectCall(asterisk, body.providerCallId);
      } else {
        const telephony = await getTenantTelephony(fastify, tenantId);
        await telephony.hangup(body.providerCallId);
      }

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
