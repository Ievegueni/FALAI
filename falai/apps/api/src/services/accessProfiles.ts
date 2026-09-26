import { prisma } from "@falai/db";
import { FEATURE_KEYS, type FeatureKey, type Features } from "./features.js";

/**
 * Perfis de acesso ao CRM (AccessProfile), geridos pela Comunica no backoffice.
 *
 * Por cima das funcionalidades do tenant (o que o cliente tem), o perfil diz o
 * que cada utilizador pode fazer com elas:
 *   none  — não vê o módulo (some do menu, a API responde 403)
 *   read  — consulta; só pedidos GET/HEAD passam
 *   write — acesso completo
 *
 * Utilizador sem perfil = sem restrição além do role. O OWNER nunca é
 * restringido, para o cliente não ficar trancado fora da própria conta.
 */

export const ACCESS_LEVELS = ["none", "read", "write"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type ProfilePermissions = Record<FeatureKey, AccessLevel>;

/** Mantém só chaves conhecidas com níveis válidos; o resto fica "none". */
export function sanitizePermissions(input: unknown): ProfilePermissions {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out = {} as ProfilePermissions;
  for (const key of FEATURE_KEYS) {
    const v = obj[key];
    out[key] = (ACCESS_LEVELS as readonly string[]).includes(v as string) ? (v as AccessLevel) : "none";
  }
  return out;
}

/** Tira das features do tenant os módulos que o perfil esconde. */
export function applyProfile(features: Features, permissions: ProfilePermissions | null): Features {
  if (!permissions) return features;
  const out = { ...features };
  for (const key of FEATURE_KEYS) {
    if (permissions[key] === "none") out[key] = false;
  }
  return out;
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; permissions: ProfilePermissions | null }>();

/** Limpar depois de mudar um perfil ou a atribuição de perfis. */
export function invalidateUserPermissions(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/** Permissões efectivas do utilizador, ou null se não tiver restrição. */
export async function userPermissions(userId: string): Promise<ProfilePermissions | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return hit.permissions;

  const user = await prisma.tenantUser.findUnique({
    where: { id: userId },
    select: { role: true, accessProfile: { select: { permissions: true } } },
  });
  const permissions = user && user.role !== "OWNER" && user.accessProfile
    ? sanitizePermissions(user.accessProfile.permissions)
    : null;
  cache.set(userId, { at: Date.now(), permissions });
  return permissions;
}

/** O nível chega para o método HTTP? GET/HEAD precisam de "read", o resto de "write". */
export function levelAllows(level: AccessLevel, method: string): boolean {
  if (level === "write") return true;
  if (level === "read") return method === "GET" || method === "HEAD";
  return false;
}
