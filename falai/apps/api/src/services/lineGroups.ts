// Grupos de linhas: um cliente divide as suas chamadas simultâneas por tipo de
// campanha (ex.: 6 para cobrança, 6 para marketing), para que um tipo nunca
// fique com as linhas do outro.
//
// Configuração no tenant:
//   lineGroupLimits  = { "COBRANCA": 6, "MARKETING": 6 }
//   defaultLineGroup = "COBRANCA"   (grupo das campanhas criadas sem lineGroup)
// Cada campanha guarda o seu `lineGroup` (ou null = grupo por omissão).
//
// O limite total do cliente (`Tenant.maxConcurrent`) continua a valer por cima
// dos grupos. Chamadas sem campanha (directas, OTP) só contam para o total.

export const LINE_GROUP_NAME_RE = /^[A-Z0-9_-]{1,32}$/;
export const LINE_GROUP_MAX_LIMIT = 50;

/** "Cobrança " → "COBRANCA". Devolve null se o nome não for válido. */
export function normalizeLineGroup(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  return LINE_GROUP_NAME_RE.test(name) ? name : null;
}

/** Lê o Json do tenant; ignora entradas inválidas em vez de rebentar o dispatcher. */
export function parseLineGroupLimits(json: unknown): Record<string, number> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    const name = normalizeLineGroup(k);
    if (!name) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > LINE_GROUP_MAX_LIMIT) continue;
    out[name] = v;
  }
  return out;
}

export interface TenantLineGroups {
  lineGroupLimits: unknown;
  defaultLineGroup: string | null;
}

/**
 * Grupo efectivo de uma campanha e o seu limite.
 * null = o cliente não tem grupos, ou a campanha está num grupo sem limite
 * definido: nesse caso só o total do cliente se aplica.
 */
export function resolveLineGroup(
  campaignLineGroup: string | null,
  tenant: TenantLineGroups
): { group: string; limit: number; isDefault: boolean } | null {
  const limits = parseLineGroupLimits(tenant.lineGroupLimits);
  if (Object.keys(limits).length === 0) return null;
  const def = normalizeLineGroup(tenant.defaultLineGroup);
  const group = normalizeLineGroup(campaignLineGroup) ?? def;
  if (!group) return null;
  const limit = limits[group];
  if (limit === undefined) return null;
  return { group, limit, isDefault: group === def };
}

/**
 * Filtro Prisma (em `Call`) das chamadas que pertencem a um grupo. As campanhas
 * sem lineGroup contam para o grupo por omissão.
 */
export function lineGroupCallFilter(g: { group: string; isDefault: boolean }) {
  return g.isDefault
    ? { campaign: { OR: [{ lineGroup: g.group }, { lineGroup: null }] } }
    : { campaign: { lineGroup: g.group } };
}

/**
 * Valida o `lineGroup` que vem da API ao criar/editar uma campanha.
 * - undefined → não mexe
 * - null / ""  → limpa (passa ao grupo por omissão)
 * - nome       → tem de ser válido e, se o cliente tiver grupos, um deles.
 */
export function validateCampaignLineGroup(
  raw: unknown,
  tenant: TenantLineGroups
): { ok: true; value: string | null | undefined } | { ok: false; error: string; allowed?: string[] } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === "") return { ok: true, value: null };
  const name = normalizeLineGroup(raw);
  if (!name) {
    return { ok: false, error: "lineGroup inválido: usa letras, números, _ ou - (máx. 32)" };
  }
  const allowed = Object.keys(parseLineGroupLimits(tenant.lineGroupLimits));
  if (allowed.length > 0 && !allowed.includes(name)) {
    return { ok: false, error: `lineGroup desconhecido: ${name}`, allowed };
  }
  return { ok: true, value: name };
}
