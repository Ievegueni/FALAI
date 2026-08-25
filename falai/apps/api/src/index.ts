import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebSocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyRawBody from "fastify-raw-body";
import fastifyMultipart from "@fastify/multipart";
import { Redis } from "ioredis";

import { config } from "./config.js";
import { resolveProviderConfig, type ResolvedProviderConfig } from "./services/providerConfig.service.js";
import { YeastarAdapter, AsteriskAdapter, trunkEndpointId, parseDialFormat, type TelephonyProvider } from "@falai/providers";
import { registerInboundCallRouter } from "./services/inboundCallRouter.service.js";
import { startDirectCallSweeper, registerDirectCallEvents } from "./services/directCall.service.js";
import { prisma } from "@falai/db";

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
import { adminTenantApiKeysRoutes } from "./routes/admin/tenant-api-keys.js";
import { adminAgentsModerationRoutes } from "./routes/admin/agents-moderation.js";
import { adminModelsModerationRoutes } from "./routes/admin/models-moderation.js";
import { tenantAuthRoutes } from "./routes/tenant/auth.js";
import { tenantAgentsRoutes } from "./routes/tenant/agents.js";
import { tenantDashboardRoutes } from "./routes/tenant/dashboard.js";
import { tenantContactsRoutes } from "./routes/tenant/contacts.js";
import { tenantCallsRoutes } from "./routes/tenant/calls.js";
import { tenantTeamRoutes } from "./routes/tenant/team.js";
import { tenantCampaignsRoutes } from "./routes/tenant/campaigns.js";
import { tenantWalletRoutes } from "./routes/tenant/wallet.js";
import { tenantPbxRoutes } from "./routes/tenant/pbx.js";
import { tenantExtensionsRoutes } from "./routes/tenant/extensions.js";
import { tenantExtensionGroupsRoutes } from "./routes/tenant/extension-groups.js";
import { tenantRolesRoutes } from "./routes/tenant/roles.js";
import { tenantTrunksRoutes } from "./routes/tenant/trunks.js";
import { tenantRoutingRoutes } from "./routes/tenant/routing.js";
import { adminTrunksRoutes } from "./routes/admin/trunks.js";
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
import { v1ModelsRoutes } from "./routes/v1/models.js";
import { v1UsageRoutes } from "./routes/v1/usage.js";
import { yeastarWebhookRoutes } from "./routes/webhooks/yeastar.js";
import { pbxWebhookRoutes } from "./routes/webhooks/pbx.js";
import { asteriskWebhookRoutes } from "./routes/webhooks/asterisk.js";
import { smsWebhookRoutes } from "./routes/webhooks/sms.js";
import { registerYeastarWebSocket } from "./websocket/yeastar.js";
import { syncAllPbx } from "./services/pbxSync.service.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Motor de telefonia em uso. Tipado pela interface para que o motor possa
     * ser trocado (Asterisk) sem tocar em quem o consome — ver
     * docs/PLANO-INDEPENDENCIA-PBX.txt §15.2.
     * Usar SEMPRE este decorador em código novo.
     */
    telephony: TelephonyProvider;
    /**
     * @deprecated Referência ao adaptador Yeastar concreto. Só para o código que
     * usa funções fora da interface (webhooks, WebSocket de eventos, CDR e o
     * produto BYO-PBX). Esse código é removido no fim da migração (§13.4).
     */
    yeastar: YeastarAdapter;
    /**
     * O motor Asterisk nativo, ou null se estiver desligado
     * (TELEPHONY_ENGINE != asterisk). Necessário para as funções que vivem
     * fora da interface TelephonyProvider — bridges, ring groups e originate
     * para um endpoint PJSIP concreto — usadas pelas chamadas directas e pelo
     * router de entrada.
     */
    asterisk: AsteriskAdapter | null;
    providerConfig: ResolvedProviderConfig;
  }
}

/**
 * Lê TRUSTED_PROXIES para o formato que o Fastify entende.
 * `false` (não confiar em ninguém) é o valor por omissão de propósito: numa
 * configuração mal feita, o pior que acontece é a allowlist ver o IP do proxy
 * e recusar pedidos legítimos — falha ruidosa e óbvia, em vez de uma porta
 * aberta em silêncio.
 */
function parseTrustedProxies(raw: string | undefined): string[] | false {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : false;
}

async function buildApp() {
  const fastify = Fastify({
    logger:
      config.NODE_ENV === "development"
        ? { level: config.LOG_LEVEL, transport: { target: "pino-pretty", options: { colorize: true } } }
        : { level: config.LOG_LEVEL },
    // Confiar SÓ nos proxies declarados. Com `trustProxy: true` o Fastify
    // aceitava o `X-Forwarded-For` de quem quer que fosse, e como o
    // `request.ip` alimenta a allowlist de IP das chaves de API, bastava um
    // cabeçalho forjado para contornar essa allowlist com uma chave roubada.
    // Sem TRUSTED_PROXIES definido usa-se o IP do socket, que é sempre seguro
    // (em dev não há proxy; em produção define-se o IP do nginx).
    trustProxy: parseTrustedProxies(config.TRUSTED_PROXIES),
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

  // Motor de telefonia activo. TELEPHONY_ENGINE=asterisk liga o motor próprio;
  // qualquer outro valor (ou ausência) mantém o PBX externo. É o interruptor
  // que permite migrar e reverter sem redeploy — ver plano §15.2.
  const useAsterisk =
    process.env["TELEPHONY_ENGINE"] === "asterisk" && Boolean(process.env["ASTERISK_ARI_URL"]);
  const asteriskAdapter = useAsterisk
    ? new AsteriskAdapter({
        baseUrl: process.env["ASTERISK_ARI_URL"]!,
        username: process.env["ASTERISK_ARI_USER"] ?? "falai",
        password: process.env["ASTERISK_ARI_PASSWORD"] ?? "",
        soundsDir: process.env["ASTERISK_SOUNDS_DIR"] ?? "",
        dialFormat: parseDialFormat(process.env["ASTERISK_DIAL_FORMAT"]),
        // Por onde sai uma chamada para a rede: o trunk activo na base de
        // dados. Lido a pedido (com cache curta no adaptador) para mudar o
        // trunk no backoffice não obrigar a reiniciar a API.
        // O trunk do PRÓPRIO cliente tem precedência; na falta dele usa-se um
        // partilhado (tenantId nulo). Nunca o de outro cliente — antes isto era
        // "o primeiro trunk activo", e um cliente saía pelo trunk e com o
        // Caller ID de outro. Sem tenant conhecido só se aceitam partilhados.
        resolveTrunk: async (tenantId?: string) => {
          const trunk = await prisma.trunk.findFirst({
            where: tenantId
              ? { enabled: true, OR: [{ tenantId }, { tenantId: null }] }
              : { enabled: true, tenantId: null },
            orderBy: [{ tenantId: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
            select: { name: true, authUser: true },
          });
          if (!trunk) return null;
          return {
            endpoint: trunkEndpointId(trunk.name),
            callerId: process.env["ASTERISK_CALLER_ID"] || trunk.authUser,
          };
        },
      })
    : null;
  const telephony: TelephonyProvider = asteriskAdapter ?? (yeastar as TelephonyProvider);
  fastify.decorate("telephony", telephony);
  fastify.decorate("asterisk", asteriskAdapter);
  fastify.log.info({ engine: useAsterisk ? "asterisk" : "yeastar" }, "telephony.engine_selected");
  // Expira sessões esquecidas em memória e fecha registos DIRECT pendurados
  // (por exemplo os de antes de um reinício, que perde o mapa de sessões).
  if (asteriskAdapter) startDirectCallSweeper(asteriskAdapter, fastify.log);

  // eventBus: multiplexor de eventos Yeastar (deve ser registado antes de callEngine e otpCallService)
  const { default: eventBusPlugin } = await import("./plugins/eventBus.js");
  await fastify.register(eventBusPlugin);

  // Router de chamadas de entrada (ARI/Stasis) — só faz sentido com o motor
  // Asterisk nativo; o Yeastar tem o seu próprio fluxo de entrada. Ver
  // services/inboundCallRouter.service.ts.
  if (asteriskAdapter) {
    registerInboundCallRouter(fastify.onCallEvent, asteriskAdapter, fastify.log);
    // Fecha a chamada directa quando quem desliga é o outro lado — sem isto só
    // o botão do CRM a fechava e o registo ficava "Em curso" para sempre.
    registerDirectCallEvents(fastify.onCallEvent, asteriskAdapter, fastify.log);
  }

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
  await fastify.register(adminTenantApiKeysRoutes, { prefix: "/admin/tenants" });
  await fastify.register(adminTrunksRoutes, { prefix: "/admin/trunks" });
  await fastify.register(adminAgentsModerationRoutes, { prefix: "/admin/agents" });
  await fastify.register(adminModelsModerationRoutes, { prefix: "/admin/models" });
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
  await fastify.register(tenantExtensionsRoutes, { prefix: "/tenant/extensions" });
  await fastify.register(tenantExtensionGroupsRoutes, { prefix: "/tenant/extension-groups" });
  await fastify.register(tenantRolesRoutes, { prefix: "/tenant/roles" });
  await fastify.register(tenantTrunksRoutes, { prefix: "/tenant/trunks" });
  await fastify.register(tenantRoutingRoutes, { prefix: "/tenant/routing" });
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
    await v1.register(v1ModelsRoutes);
    await v1.register(v1UsageRoutes);
  });

  // ── Webhooks ────────────────────────────────────────────────────────────
  await fastify.register(yeastarWebhookRoutes, { prefix: "/webhooks/yeastar" });
  await fastify.register(pbxWebhookRoutes, { prefix: "/webhooks/pbx" });
  // CDR das chamadas marcadas no telefone — chamado pelo dialplan do Asterisk
  await fastify.register(asteriskWebhookRoutes, { prefix: "/webhooks/asterisk" });
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

    // Projecta a configuração PBX para o motor próprio. Fire-and-forget: se o
    // motor estiver em baixo, a API arranca na mesma e as chamadas continuam a
    // sair pelo PBX externo.
    void syncAllPbx()
      .then(() => app.log.info("pbx_sync.boot_complete"))
      .catch((err) => app.log.warn({ err }, "pbx_sync.boot_failed"));
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();

export { buildApp };
