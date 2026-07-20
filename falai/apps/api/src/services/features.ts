/**
 * Funcionalidades que o operador pode activar/desactivar por cliente no backoffice.
 *
 * As features efectivas resultam de três camadas, por ordem:
 *   1. DEFAULT_FEATURES  — valores base da plataforma
 *   2. overrides do tenant (Tenant.features)  — decisão explícita do operador
 *   3. limite do plano  — se o plano não tem IA, agentes/campanhas ficam sempre off
 */

export const FEATURE_KEYS = [
  "agents",
  "campaigns",
  "contacts",
  "calls",
  "directCall",
  "otpCall",
  "wallet",
  "team",
  "developers",
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
  wallet: "Carteira",
  team: "Equipa",
  developers: "Developers / API",
};

export const DEFAULT_FEATURES: Features = {
  agents: true,
  campaigns: true,
  contacts: true,
  calls: true,
  directCall: true,
  otpCall: false,
  wallet: true,
  team: true,
  developers: true,
};

/**
 * Calcula as features efectivas de um tenant.
 */
export function computeFeatures(input: {
  overrides?: unknown;
  aiAgentsEnabled?: boolean;
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

  return result;
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
