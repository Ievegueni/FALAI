import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebSocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyRawBody from "fastify-raw-body";
import fastifyMultipart from "@fastify/multipart";
import { Redis } from "ioredis";

import { config } from "./config.js";
import { resolveProviderConfig, type ResolvedProviderConfig } from "./services/providerConfig.service.js";
import { YeastarAdapter } from "@falai/providers";

import redisPlugin from "./plugins/redis.js";
import authPlugin from "./plugins/auth.js";
import auditPlugin from "./plugins/audit.js";
import tenantAuthPlugin from "./plugins/tenantAuth.js";
import callEnginePlugin from "./plugins/callEngine.js";
import campaignDispatcherPlugin from "./plugins/campaignDispatcher.js";

import { adminAuthRoutes } from "./routes/admin/auth.js";
import { adminSettingsRoutes } from "./routes/admin/settings.js";
import { adminTestCallRoutes } from "./routes/admin/test-call.js";
import { adminCallsRoutes } from "./routes/admin/calls.js";
import { adminSimulateRoutes } from "./routes/admin/simulate-conversation.js";
import { adminPlansRoutes } from "./routes/admin/plans.js";
import { adminTenantsRoutes } from "./routes/admin/tenants.js";
import { adminAgentsModerationRoutes } from "./routes/admin/agents-moderation.js";
import { tenantAuthRoutes } from "./routes/tenant/auth.js";
import { tenantAgentsRoutes } from "./routes/tenant/agents.js";
import { tenantDashboardRoutes } from "./routes/tenant/dashboard.js";
import { tenantContactsRoutes } from "./routes/tenant/contacts.js";
import { tenantCallsRoutes } from "./routes/tenant/calls.js";
import { tenantTeamRoutes } from "./routes/tenant/team.js";
import { tenantCampaignsRoutes } from "./routes/tenant/campaigns.js";
import { tenantWalletRoutes } from "./routes/tenant/wallet.js";
import { tenantPbxRoutes } from "./routes/tenant/pbx.js";
import { tenantBillingRoutes } from "./routes/tenant/billing.js";
import { tenantApiKeysRoutes } from "./routes/tenant/api-keys.js";
import { tenantWebhookEventsRoutes } from "./routes/tenant/webhook-events.js";
import { tenantSettingsRoutes } from "./routes/tenant/settings.js";
import { tenantEventsRoutes } from "./routes/tenant/events.js";
import { tenantReportsRoutes } from "./routes/tenant/reports.js";
import { tenantSmsRoutes } from "./routes/tenant/sms.js";
import { adminAuditRoutes } from "./routes/admin/audit.js";
import { adminDashboardRoutes } from "./routes/admin/dashboard.js";
import { adminFinanceRoutes } from "./routes/admin/finance.js";
import { adminHealthRoutes } from "./routes/admin/health.js";
import { proxypayWebhookRoutes } from "./routes/webhooks/proxypay.js";
import { v1CallsRoutes } from "./routes/v1/calls.js";
import { v1AgentsRoutes } from "./routes/v1/agents.js";
import { v1ContactsRoutes } from "./routes/v1/contacts.js";
import { v1CampaignsRoutes } from "./routes/v1/campaigns.js";
import { v1WalletRoutes } from "./routes/v1/wallet.js";
import { v1OtpRoutes } from "./routes/v1/otp.js";
import { v1SmsRoutes } from "./routes/v1/sms.js";
import { yeastarWebhookRoutes } from "./routes/webhooks/yeastar.js";
import { pbxWebhookRoutes } from "./routes/webhooks/pbx.js";
import { smsWebhookRoutes } from "./routes/webhooks/sms.js";
import { registerYeastarWebSocket } from "./websocket/yeastar.js";

declare module "fastify" {
  interface FastifyInstance {
    yeastar: YeastarAdapter;
    providerConfig: ResolvedProviderConfig;
  }
}

async function buildApp() {
  const fastify = Fastify({
    logger:
      config.NODE_ENV === "development"
        ? { level: config.LOG_LEVEL, transport: { target: "pino-pretty", options: { colorize: true } } }
        : { level: config.LOG_LEVEL },
    trustProxy: true,
  });

  // ── Core plugins ───────────────────────────────────────────────────────
  await fastify.register(fastifyRawBody, { global: false });
  await fastify.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max
  // Em produção: usa a whitelist de ALLOWED_ORIGINS se definida; senão bloqueia
  // cross-origin (FE e API na mesma origem/proxy). Em dev: reflecte qualquer origem.
  const allowedOrigins = config.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  const corsOrigin =
    config.NODE_ENV === "production" ? (allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : false) : true;
  await fastify.register(fastifyCors, {
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await fastify.register(fastifyWebSocket);
  await fastify.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    redis: new Redis(config.REDIS_URL),
  });

  // ── App plugins (order matters: redis → auth → audit → tenantAuth → yeastar → callEngine) ──
  await fastify.register(redisPlugin);
  await fastify.register(authPlugin);
  await fastify.register(auditPlugin);
  await fastify.register(tenantAuthPlugin);

  // Hub de "screen pop" (chamadas a entrar → push SSE para o CRM)
  const { default: incomingCallsPlugin } = await import("./plugins/incomingCalls.js");
  await fastify.register(incomingCallsPlugin);

  // API key auth plugin (provides verifyScope decorator)
  const { default: apiKeyAuthPlugin } = await import("./plugins/apiKeyAuth.js");
  await fastify.register(apiKeyAuthPlugin);

  // Resolve provider config (SystemSetting → .env → default). Lido uma vez no
  // arranque; alterações no backoffice só valem após reiniciar a API.
  const providerConfig = await resolveProviderConfig();
  fastify.decorate("providerConfig", providerConfig);

  // Yeastar adapter (decorated before callEngine plugin needs it)
  const yeastar = new YeastarAdapter(
    {
      baseUrl: providerConfig.yeastar.baseUrl,
      clientId: providerConfig.yeastar.clientId,
      clientSecret: providerConfig.yeastar.clientSecret,
      stubMode: providerConfig.yeastar.stubMode,
    },
    fastify.redis
  );
  fastify.decorate("yeastar", yeastar);

  // eventBus: multiplexor de eventos Yeastar (deve ser registado antes de callEngine e otpCallService)
  const { default: eventBusPlugin } = await import("./plugins/eventBus.js");
  await fastify.register(eventBusPlugin);

  // Call engine wires STT/LLM/TTS e regista no eventBus
  await fastify.register(callEnginePlugin);

  // OTP call service — chamadas de entrega de código por voz
  const { default: otpCallServicePlugin } = await import("./plugins/otpCallService.js");
  await fastify.register(otpCallServicePlugin);

  await fastify.register(campaignDispatcherPlugin);

  // ── Routes ─────────────────────────────────────────────────────────────
  // ── Admin routes ────────────────────────────────────────────────────────
  await fastify.register(adminAuthRoutes, { prefix: "/admin/auth" });
  await fastify.register(adminSettingsRoutes, { prefix: "/admin/settings" });
  await fastify.register(adminTestCallRoutes, { prefix: "/admin/test-call" });
  await fastify.register(adminCallsRoutes, { prefix: "/admin/calls" });
  await fastify.register(adminSimulateRoutes, { prefix: "/admin/simulate-conversation" });
  await fastify.register(adminPlansRoutes, { prefix: "/admin/plans" });
  await fastify.register(adminTenantsRoutes, { prefix: "/admin/tenants" });
  await fastify.register(adminAgentsModerationRoutes, { prefix: "/admin/agents" });
  await fastify.register(adminAuditRoutes);
  await fastify.register(adminDashboardRoutes, { prefix: "/admin" });
  await fastify.register(adminFinanceRoutes, { prefix: "/admin" });
  await fastify.register(adminHealthRoutes, { prefix: "/admin" });

  // ── Tenant (CRM) routes ─────────────────────────────────────────────────
  await fastify.register(tenantAuthRoutes, { prefix: "/tenant/auth" });
  await fastify.register(tenantAgentsRoutes, { prefix: "/tenant/agents" });
  await fastify.register(tenantDashboardRoutes, { prefix: "/tenant/dashboard" });
  await fastify.register(tenantContactsRoutes, { prefix: "/tenant/contacts" });
  await fastify.register(tenantCallsRoutes, { prefix: "/tenant/calls" });
  await fastify.register(tenantCampaignsRoutes, { prefix: "/tenant/campaigns" });
  await fastify.register(tenantWalletRoutes, { prefix: "/tenant/wallet" });
  await fastify.register(tenantPbxRoutes, { prefix: "/tenant/pbx" });
  await fastify.register(tenantBillingRoutes, { prefix: "/tenant/billing" });
  await fastify.register(tenantTeamRoutes, { prefix: "/tenant/team" });
  await fastify.register(tenantApiKeysRoutes);
  await fastify.register(tenantWebhookEventsRoutes);
  await fastify.register(tenantSettingsRoutes);
  await fastify.register(tenantEventsRoutes);
  await fastify.register(tenantReportsRoutes);
  await fastify.register(tenantSmsRoutes);

  // ── Public API v1 (API key authenticated, per-key rate limiting) ─────────
  await fastify.register(async (v1) => {
    // Per-API-key rate limit: 300 req/min (separate from global limit)
    await v1.register(fastifyRateLimit, {
      max: 300,
      timeWindow: "1 minute",
      keyGenerator: (req) => {
        const apiKey = (req as typeof req & { apiKey?: { id: string } }).apiKey;
        return apiKey?.id ?? req.ip;
      },
      redis: new Redis(config.REDIS_URL),
    });
    await v1.register(v1CallsRoutes);
    await v1.register(v1AgentsRoutes);
    await v1.register(v1ContactsRoutes);
    await v1.register(v1CampaignsRoutes);
    await v1.register(v1WalletRoutes);
    await v1.register(v1OtpRoutes);
    await v1.register(v1SmsRoutes);
  });

  // ── Webhooks ────────────────────────────────────────────────────────────
  await fastify.register(yeastarWebhookRoutes, { prefix: "/webhooks/yeastar" });
  await fastify.register(pbxWebhookRoutes, { prefix: "/webhooks/pbx" });
  await fastify.register(smsWebhookRoutes, { prefix: "/webhooks/sms" });
  await fastify.register(proxypayWebhookRoutes, { prefix: "/webhooks/proxypay" });

  // ── WebSocket ──────────────────────────────────────────────────────────
  registerYeastarWebSocket(fastify);

  // ── Health ─────────────────────────────────────────────────────────────
  fastify.get("/health", async () => {
    const yeastarHealth = await yeastar.healthCheck();
    return {
      status: "ok",
      activeCalls: fastify.callEngine.activeCallCount,
      providers: { yeastar: yeastarHealth },
    };
  });

  return fastify;
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();

export { buildApp };
