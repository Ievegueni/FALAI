import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { pbxCallStatus } from "../../services/pbxCdr.service.js";

function mapCall(c: any) {
  return {
    id: c.id, tenantId: c.tenantId, agentId: c.agentId,
    to: c.toNumber, status: c.status, outcome: c.outcome,
    durationSecs: c.durationSecs, costCents: c.costCents, providerCostCents: c.providerCostCents,
    failReason: c.failReason, startedAt: c.startedAt, endedAt: c.endedAt, createdAt: c.createdAt,
    tenant: c.tenant ?? null, agent: c.agent ?? null, source: "ai",
  };
}

const PBX_DIRECTION: Record<string, string> = { Inbound: "Entrada", Outbound: "Saída", Internal: "Interna" };

function mapPbxToAdmin(c: any) {
  return {
    id: c.id, tenantId: c.tenantId, agentId: null,
    to: c.callType === "Inbound" ? c.fromNumber : c.toNumber,
    status: pbxCallStatus(c.disposition), outcome: c.disposition,
    durationSecs: c.talkSecs || c.durationSecs, costCents: 0, providerCostCents: 0,
    failReason: null, startedAt: c.startedAt, endedAt: null, createdAt: c.startedAt,
    tenant: c.tenant ?? null, agent: { name: PBX_DIRECTION[c.callType] ?? c.callType }, source: "pbx",
  };
}

// Mapeia um estado de Call para as disposições de CDR equivalentes (filtro na lista)
function statusToDispositions(status: string): string[] | null {
  switch (status) {
    case "COMPLETED": return ["ANSWERED", "VOICEMAIL"];
    case "NO_ANSWER": return ["NO ANSWER"];
    case "FAILED": return ["FAILED", "BUSY"];
    default: return null; // estados sem equivalente no CDR (DIALING/RINGING/…)
  }
}

export const adminCallsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/calls
  fastify.get<{
    Querystring: { status?: string; tenantId?: string; page?: string; perPage?: string };
  }>("/", { preHandler }, async (request) => {
    const { status, tenantId } = request.query;
    const page = parseInt(request.query.page ?? "1", 10);
    const perPage = parseInt(request.query.perPage ?? "25", 10);
    const skip = (page - 1) * perPage;

    const where = {
      ...(status && { status: status as any }),
      ...(tenantId && { tenantId }),
    };

    // Filtro para PbxCall (CDR dos tenants CRM). Se o estado filtrado não tiver
    // equivalente no CDR, excluímos as chamadas de PBX.
    const dispositions = status ? statusToDispositions(status) : undefined;
    const pbxWhere =
      status && !dispositions
        ? { id: "__none__" }
        : {
            ...(tenantId && { tenantId }),
            ...(dispositions && { disposition: { in: dispositions } }),
          };

    // Buscar skip+perPage mais recentes de cada fonte garante a fatia correta da união
    const window = skip + perPage;
    const [calls, callTotal, pbxCalls, pbxTotal] = await Promise.all([
      prisma.call.findMany({
        where, orderBy: { createdAt: "desc" }, take: window,
        include: { tenant: { select: { name: true } }, agent: { select: { name: true } } },
      }),
      prisma.call.count({ where }),
      prisma.pbxCall.findMany({
        where: pbxWhere as any, orderBy: { startedAt: "desc" }, take: window,
        include: { tenant: { select: { name: true } } },
      }),
      prisma.pbxCall.count({ where: pbxWhere as any }),
    ]);

    const merged = [...calls.map(mapCall), ...pbxCalls.map(mapPbxToAdmin)]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(skip, skip + perPage);

    return { data: merged, total: callTotal + pbxTotal, page, perPage };
  });

  // GET /admin/calls/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const call = await prisma.call.findUnique({
      where: { id: request.params.id },
      include: {
        turns: { orderBy: { seq: "asc" } },
        agent: { select: { name: true, ttsVoiceId: true } },
        tenant: { select: { name: true } },
      },
    });
    if (!call) {
      // Fallback: chamada de PBX (tenant CRM) — sem turnos de IA
      const pbxCall = await prisma.pbxCall.findUnique({
        where: { id: request.params.id },
        include: { tenant: { select: { name: true } } },
      });
      if (pbxCall) {
        return {
          ...mapPbxToAdmin(pbxCall),
          summary: null,
          turns: [],
          latencyStats: { turnCount: 0, avgSttMs: 0, avgLlmMs: 0, avgTtsMs: 0, p95SttMs: 0, p95LlmMs: 0, totalCostCents: 0 },
        };
      }
      return reply.status(404).send({ error: "Chamada não encontrada" });
    }

    const agentTurns = call.turns.filter((t) => t.role === "AGENT");
    const latencyStats = {
      turnCount: agentTurns.length,
      avgSttMs: avg(agentTurns.map((t) => t.sttMs)),
      avgLlmMs: avg(agentTurns.map((t) => t.llmMs)),
      avgTtsMs: avg(agentTurns.map((t) => t.ttsMs)),
      p95SttMs: p95(agentTurns.map((t) => t.sttMs)),
      p95LlmMs: p95(agentTurns.map((t) => t.llmMs)),
      totalCostCents: call.costCents,
    };

    return {
      ...mapCall(call),
      summary: call.summary,
      turns: call.turns.map((t) => ({
        seq: t.seq,
        role: t.role === "AGENT" ? "assistant" : "user",
        text: t.text,
        audioRef: t.audioRef,
        sttMs: t.sttMs, llmMs: t.llmMs, ttsMs: t.ttsMs, playMs: t.playMs,
        createdAt: t.createdAt,
      })),
      latencyStats,
    };
  });
};

function avg(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function p95(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (!nums.length) return null;
  return nums[Math.min(Math.floor(nums.length * 0.95), nums.length - 1)] ?? null;
}
