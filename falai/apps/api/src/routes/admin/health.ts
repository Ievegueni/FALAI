import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";

export const adminHealthRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/health/providers
  fastify.get("/health/providers", { preHandler }, async () => {
    const [yeastarHealth, recentEvents, systemSettings] = await Promise.all([
      fastify.yeastar.healthCheck(),
      prisma.systemEvent.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
      prisma.systemSetting.findFirst({ where: { key: "MAX_CONCURRENT_CALLS" } }),
    ]);

    // Redis ping
    let redisOk = false;
    let redisLatency: number | null = null;
    try {
      const t = Date.now();
      await fastify.redis.ping();
      redisLatency = Date.now() - t;
      redisOk = true;
    } catch {}

    // DB ping
    let dbOk = false;
    let dbLatency: number | null = null;
    try {
      const t = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      dbLatency = Date.now() - t;
      dbOk = true;
    } catch {}

    const providers = [
      {
        name: "Yeastar PBX",
        status: yeastarHealth.ok ? "ok" : "down",
        latencyMs: null,
        detail: yeastarHealth.details ?? null,
      },
      {
        name: "Redis",
        status: redisOk ? "ok" : "down",
        latencyMs: redisLatency,
        detail: redisOk ? "Conexão activa" : "Falha na conexão",
      },
      {
        name: "Base de Dados",
        status: dbOk ? "ok" : "down",
        latencyMs: dbLatency,
        detail: dbOk ? `Latência: ${dbLatency}ms` : "Falha na conexão",
      },
      {
        name: "Deepgram STT",
        status: fastify.providerConfig.deepgram.apiKey ? "ok" : "unknown",
        latencyMs: null,
        detail: fastify.providerConfig.deepgram.apiKey ? "Chave configurada" : "Chave não configurada (modo stub)",
      },
      {
        name: "Anthropic LLM",
        status: fastify.providerConfig.anthropic.apiKey ? "ok" : "unknown",
        latencyMs: null,
        detail: fastify.providerConfig.anthropic.apiKey ? "Chave configurada" : "Chave não configurada (modo stub)",
      },
      {
        name: "ElevenLabs TTS",
        status: fastify.providerConfig.elevenlabs.apiKey ? "ok" : "unknown",
        latencyMs: null,
        detail: fastify.providerConfig.elevenlabs.apiKey ? "Chave configurada" : "Chave não configurada (modo stub)",
      },
    ];

    return {
      providers,
      concurrentCalls: fastify.callEngine?.activeCallCount ?? 0,
      concurrentCapacity: parseInt(systemSettings?.value ?? "50", 10),
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        severity: e.severity.toLowerCase() as "info" | "warning" | "error",
        source: e.source,
        message: e.message,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  // GET /admin/system-events
  fastify.get<{ Querystring: { page?: string; severity?: string; source?: string } }>(
    "/system-events", { preHandler }, async (request) => {
      const page = parseInt(request.query.page ?? "1", 10);
      const perPage = 25;
      const skip = (page - 1) * perPage;

      const where = {
        ...(request.query.severity && { severity: request.query.severity.toUpperCase() }),
        ...(request.query.source && { source: request.query.source }),
      };

      const [events, total] = await Promise.all([
        prisma.systemEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: perPage, skip }),
        prisma.systemEvent.count({ where }),
      ]);

      return {
        data: events.map((e) => ({
          id: e.id,
          severity: e.severity.toLowerCase() as "info" | "warning" | "error",
          source: e.source,
          message: e.message,
          payload: e.payload,
          createdAt: e.createdAt.toISOString(),
        })),
        total, page, perPage,
      };
    }
  );
};
