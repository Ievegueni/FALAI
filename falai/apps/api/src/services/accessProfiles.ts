import type { FastifyReply, FastifyRequest } from "fastify";
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
 *
 * Além dos módulos (features), o perfil controla o Dashboard, que não é uma
 * feature do tenant (todos o têm) mas mostra saldo e totais da conta que nem
 * todos os membros devem ver. Só tem "none" e "read".
 */

export const ACCESS_LEVELS = ["none", "read", "write"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Chaves do perfil que não são features do tenant. */
export const EXTRA_PROFILE_KEYS = ["dashboard"] as const;
export type ProfileKey = (typeof EXTRA_PROFILE_KEYS)[number] | FeatureKey;
export type ProfilePermissions = Record<ProfileKey, AccessLevel>;

/**
 * Mantém só chaves conhecidas com níveis válidos; o resto fica "none".
 * Excepção: o Dashboard em falta fica "read", porque os perfis criados antes
 * de ele existir davam-no a toda a gente. "write" no Dashboard vale "read".
 */
export function sanitizePermissions(input: unknown): ProfilePermissions {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out = {} as ProfilePermissions;
  // Lista montada aqui e não ao carregar o módulo: features.ts importa este
  // ficheiro, e no bundle FEATURE_KEYS ainda não existe nesse momento.
  const keys: ProfileKey[] = [...EXTRA_PROFILE_KEYS, ...FEATURE_KEYS];
  for (const key of keys) {
    const v = obj[key];
    out[key] = (ACCESS_LEVELS as readonly string[]).includes(v as string) ? (v as AccessLevel) : "none";
  }
  out.dashboard = obj.dashboard === "none" ? "none" : "read";
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

/**
 * preHandler para rotas do CRM guardadas por uma chave do perfil que não é
 * feature (ex.: Dashboard). As features passam por requireFeature.
 */
export function requireProfileAccess(key: (typeof EXTRA_PROFILE_KEYS)[number]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.tenantUser) return;
    const permissions = await userPermissions(request.tenantUser.sub);
    if (permissions && !levelAllows(permissions[key], request.method)) {
      return reply.status(403).send({ error: "O teu perfil não dá acesso ao Dashboard", feature: key });
    }
  };
}
