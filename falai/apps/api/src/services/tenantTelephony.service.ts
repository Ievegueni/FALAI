import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { YeastarAdapter } from "@falai/providers";
import { decryptSecret } from "./crypto.service.js";

/**
 * Resolve o adaptador de telefonia correcto para um tenant.
 *
 * - Plano VOICE_AI (operador): usa o PBX global da plataforma (`fastify.yeastar`).
 * - Plano CRM_BYO_PBX com credenciais próprias: cria/cacheia um YeastarAdapter
 *   dedicado, com token isolado no Redis (`yeastar:token:tenant:{id}`).
 *
 * Os adaptadores por tenant são cacheados e invalidados quando as credenciais mudam
 * (via fingerprint) ou explicitamente (`invalidateTenantTelephony`).
 */

interface CacheEntry {
  fingerprint: string;
  adapter: YeastarAdapter;
}

const cache = new Map<string, CacheEntry>();

export function invalidateTenantTelephony(tenantId: string): void {
  cache.delete(tenantId);
}

/** Indica se o tenant tem PBX próprio configurado (plano CRM + credenciais completas). */
export function hasOwnPbx(tenant: {
  plan: { productType: string };
  pbxBaseUrl: string | null;
  pbxClientId: string | null;
  pbxClientSecret: string | null;
}): boolean {
  return (
    tenant.plan.productType === "CRM_BYO_PBX" &&
    !!tenant.pbxBaseUrl &&
    !!tenant.pbxClientId &&
    !!tenant.pbxClientSecret
  );
}

/**
 * Devolve o motor Asterisk SÓ se ele estiver ligado E o tenant não tiver PBX
 * próprio. O decorador `fastify.asterisk` é global ao processo; usá-lo directo
 * numa rota atropela a escolha por tenant e manda as chamadas de um cliente com
 * PBX próprio para o nosso trunk — com o callerID de outro cliente.
 *
 * Regra: quem tem PBX próprio manda no seu PBX; os restantes vão pelo motor
 * activo da plataforma.
 */
export async function getTenantAsterisk(
  fastify: FastifyInstance,
  tenantId: string,
): Promise<FastifyInstance["asterisk"]> {
  if (!fastify.asterisk) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      pbxBaseUrl: true,
      pbxClientId: true,
      pbxClientSecret: true,
      plan: { select: { productType: true } },
    },
  });
  if (!tenant) throw new Error("Tenant não encontrado");
  return hasOwnPbx(tenant) ? null : fastify.asterisk;
}

export async function getTenantTelephony(fastify: FastifyInstance, tenantId: string): Promise<YeastarAdapter> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      pbxBaseUrl: true,
      pbxClientId: true,
      pbxClientSecret: true,
      plan: { select: { productType: true } },
    },
  });
  if (!tenant) throw new Error("Tenant não encontrado");

  // Plano operador ou sem credenciais próprias → PBX global da plataforma
  if (!hasOwnPbx(tenant)) return fastify.yeastar;

  const fingerprint = `${tenant.pbxBaseUrl}|${tenant.pbxClientId}|${tenant.pbxClientSecret}`;
  const cached = cache.get(tenantId);
  if (cached && cached.fingerprint === fingerprint) return cached.adapter;

  const adapter = new YeastarAdapter(
    {
      baseUrl: tenant.pbxBaseUrl!,
      clientId: tenant.pbxClientId!,
      clientSecret: decryptSecret(tenant.pbxClientSecret!),
      stubMode: false,
      instanceId: `tenant:${tenantId}`,
    },
    fastify.redis
  );
  cache.set(tenantId, { fingerprint, adapter });
  return adapter;
}
