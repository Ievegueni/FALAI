import type { FastifyReply, FastifyRequest, RouteOptions, preHandlerHookHandler } from "fastify";
import { prisma } from "@falai/db";
import { userPermissions, levelAllows } from "./accessProfiles.js";

/**
 * Funcionalidades que o operador pode activar/desactivar por cliente no backoffice.
 *
 * As features efectivas resultam de três camadas, por ordem:
 *   1. DEFAULT_FEATURES  — valores base da plataforma
 *   2. overrides do tenant (Tenant.features)  — decisão explícita do operador
 *   3. limite do plano  — se o plano não tem IA, agentes/campanhas ficam sempre off;
 *      se o produto é API_BYOM, o cliente não tem UI nossa de todo
 */

export const FEATURE_KEYS = [
  "agents",
  "campaigns",
  "contacts",
  "calls",
  "directCall",
  "otpCall",
  "webphone",
  "wallet",
  "team",
  "developers",
  "reports",
  "sms",
  "telephony",
  "inbox",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;

// Rótulos legíveis para o backoffice
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  agents: "Agentes de IA",
  campaigns: "Campanhas",
  contacts: "Contactos",
  calls: "Histórico de chamadas",
  directCall: "Chamada directa (click-to-call)",
  otpCall: "OTP por voz",
  webphone: "Webphone (telefone no browser)",
  wallet: "Carteira",
  team: "Equipa",
  developers: "Developers / API",
  reports: "Relatórios",
  sms: "SMS",
  telephony: "Telefonia (extensões, trunks, rotas)",
  inbox: "Caixa de entrada (WhatsApp, chat, email, Telegram)",
};

export const FEATURE_HINTS: Record<FeatureKey, string> = {
  agents: "Criar e gerir agentes de IA e chamadas com IA",
  campaigns: "Campanhas de chamadas automáticas",
  contacts: "Base de contactos",
  calls: "Registo e detalhe de chamadas",
  directCall: "Click-to-call de uma extensão para um número",
  otpCall: "Entrega de códigos OTP por chamada (API)",
  webphone: "Telefone no browser (WebRTC)",
  wallet: "Saldo e movimentos",
  team: "Utilizadores do cliente",
  developers: "API keys, webhooks e documentação",
  reports: "Relatórios de chamadas (CSV/PDF)",
  sms: "Envio de SMS avulso e campanhas (o plano tem de incluir SMS)",
  telephony: "Extensões, grupos, trunks e rotas",
  inbox: "WhatsApp Business, chat no site, email e Telegram, com IA e operadores",
};

export const DEFAULT_FEATURES: Features = {
  agents: true,
  campaigns: true,
  contacts: true,
  calls: true,
  directCall: true,
  otpCall: false,
  webphone: true,
  wallet: true,
  team: true,
  developers: true,
  reports: true,
  sms: true,
  telephony: true,
  // Funcionalidades novas nascem desligadas: só aparecem a um cliente quando
  // a Comunica as activa no backoffice.
  inbox: false,
};

/**
 * Calcula as features efectivas de um tenant.
 */
export function computeFeatures(input: {
  overrides?: unknown;
  aiAgentsEnabled?: boolean;
  smsEnabled?: boolean;
  productType?: string;
  /**
   * Vista da API pública (/v1). O API_BYOM desliga a nossa UI mas usa a API
   * — aí manda o scope da chave, não as features.
   */
  forApi?: boolean;
}): Features {
  const result: Features = { ...DEFAULT_FEATURES };

  // 2. overrides explícitos do operador
  const overrides = (input.overrides ?? {}) as Record<string, unknown>;
  for (const key of FEATURE_KEYS) {
    if (typeof overrides[key] === "boolean") {
      result[key] = overrides[key] as boolean;
    }
  }

  // 3. limite duro do plano: sem IA não há agentes nem campanhas
  if (input.aiAgentsEnabled === false) {
    result.agents = false;
    result.campaigns = false;
  }
  if (input.smsEnabled === false) result.sms = false;

  // 3b. API_BYOM: o cliente tem o CRM dele e fala connosco só por API. Nenhum
  // override liga a nossa UI — só fica a área de developers (chaves e IPs).
  if (input.productType === "API_BYOM" && !input.forApi) {
    for (const key of FEATURE_KEYS) result[key] = false;
    result.developers = true;
  }

  return result;
}

/**
 * Funcionalidades que o plano desliga e que nenhum override consegue ligar
 * (sem IA, sem SMS, produto API_BYOM). O backoffice mostra-as bloqueadas em vez
 * de deixar ligar um interruptor que o plano anula logo a seguir.
 */
export function lockedByPlan(plan: {
  aiAgentsEnabled?: boolean;
  smsEnabled?: boolean;
  productType?: string;
} | null | undefined): FeatureKey[] {
  const allOn = computeFeatures({
    overrides: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])),
    ...(plan?.aiAgentsEnabled !== undefined && { aiAgentsEnabled: plan.aiAgentsEnabled }),
    ...(plan?.smsEnabled !== undefined && { smsEnabled: plan.smsEnabled }),
    ...(plan?.productType !== undefined && { productType: plan.productType }),
  });
  return FEATURE_KEYS.filter((k) => !allOn[k]);
}

/**
 * Valida e normaliza um objecto de overrides recebido do backoffice,
 * mantendo apenas chaves conhecidas com valores booleanos.
 */
export function sanitizeFeatureOverrides(input: unknown): Partial<Features> {
  const out: Partial<Features> = {};
  if (!input || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;
  for (const key of FEATURE_KEYS) {
    if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
  }
  return out;
}

// ── Aplicação na API ─────────────────────────────────────────────────────────


const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; tenant: { features: unknown; plan: { aiAgentsEnabled: boolean; smsEnabled: boolean; productType: string } } }>();

/** Limpar depois de mudar features ou plano de um tenant no backoffice. */
export function invalidateTenantFeatures(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function tenantFeatures(tenantId: string, opts: { forApi?: boolean } = {}): Promise<Features> {
  let hit = cache.get(tenantId);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true, plan: { select: { aiAgentsEnabled: true, smsEnabled: true, productType: true } } },
    });
    if (!tenant) return Object.fromEntries(FEATURE_KEYS.map((k) => [k, false])) as Features;
    hit = { at: Date.now(), tenant };
    cache.set(tenantId, hit);
  }
  const { features, plan } = hit.tenant;
  return computeFeatures({
    overrides: features,
    aiAgentsEnabled: plan.aiAgentsEnabled,
    smsEnabled: plan.smsEnabled,
    productType: plan.productType,
    ...(opts.forApi && { forApi: true }),
  });
}

export async function tenantHasFeature(tenantId: string, key: FeatureKey): Promise<boolean> {
  return (await tenantFeatures(tenantId))[key];
}

/**
 * preHandler: 403 se a funcionalidade não estiver activa para o tenant do
 * pedido (JWT do CRM ou API key). Corre depois da autenticação da rota.
 */
export function requireFeature(key: FeatureKey | FeatureKey[]): preHandlerHookHandler {
  const keys = Array.isArray(key) ? key : [key];
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const viaApi = !!request.apiKey;
    const tenantId = request.tenantUser?.tenantId ?? request.apiKey?.tenantId;
    if (!tenantId) return; // rota sem autenticação de tenant: não é daqui
    const features = await tenantFeatures(tenantId, { forApi: viaApi });
    // Lista = basta uma estar activa (ex.: extensões servem Telefonia e Webphone).
    if (!keys.some((k) => features[k])) {
      return reply.status(403).send({ error: `Funcionalidade não activa: ${keys.map((k) => FEATURE_LABELS[k]).join(" / ")}`, feature: keys[0] });
    }
    // Perfil de acesso do utilizador do CRM (as API keys regem-se pelos scopes).
    if (!viaApi && request.tenantUser) {
      const permissions = await userPermissions(request.tenantUser.sub);
      if (permissions && !keys.some((k) => features[k] && levelAllows(permissions[k], request.method))) {
        const canRead = keys.some((k) => features[k] && permissions[k] !== "none");
        return reply.status(403).send({
          error: canRead
            ? `O teu perfil só permite consultar: ${keys.map((k) => FEATURE_LABELS[k]).join(" / ")}`
            : `O teu perfil não dá acesso a: ${keys.map((k) => FEATURE_LABELS[k]).join(" / ")}`,
          feature: keys[0],
        });
      }
    }
  };
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Sobrepõe a funcionalidade do grupo de rotas (ver gateFeature). Lista = qualquer uma. */
    feature?: FeatureKey | FeatureKey[];
  }
}

/**
 * Hook onRoute: acrescenta requireFeature a todas as rotas do plugin onde é
 * registado, depois dos preHandlers de autenticação. Uma rota pode indicar
 * outra funcionalidade com `config: { feature }`.
 */
export function gateFeature(key: FeatureKey) {
  return (route: RouteOptions) => {
    const feature = (route.config as { feature?: FeatureKey | FeatureKey[] } | undefined)?.feature ?? key;
    const existing = route.preHandler ? (Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler]) : [];
    route.preHandler = [...existing, requireFeature(feature)];
  };
}
