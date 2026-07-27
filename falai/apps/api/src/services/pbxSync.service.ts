/**
 * Sincronização da config do tenant com o motor de chamadas (Fase 4).
 * Monta o snapshot a partir do Prisma (desencriptando os segredos SIP) e
 * entrega-o ao `TrunkRuntimeAdapter`. Hoje usa o stub Noop — trocar pelo
 * adaptador do motor real (Asterisk/FreeSWITCH/…) quando existir.
 *
 * Ver docs/sip_trunk.md §0 e §2. As mutações de extensões/trunks/rotas chamam
 * `syncTenantPbx(tenantId)` em fire-and-forget (não bloqueia a resposta).
 */
import { prisma } from "@falai/db";
import { NoopTrunkRuntimeAdapter, type TrunkRuntimeAdapter, type PbxSyncPayload } from "@falai/providers";
import { decryptSecret } from "./crypto.service.js";

// Singleton do motor. Substituir a fábrica quando o motor real existir.
let engine: TrunkRuntimeAdapter | null = null;
export function getTrunkRuntime(): TrunkRuntimeAdapter {
  if (!engine) {
    engine = new NoopTrunkRuntimeAdapter((msg, meta) => console.log(`[pbx-runtime] ${msg}`, meta ?? ""));
  }
  return engine;
}

function safeDecrypt(v: string): string {
  try {
    return decryptSecret(v);
  } catch {
    return "";
  }
}

/** Constrói o snapshot da config de um tenant, incluindo o trunk partilhado. */
export async function buildPbxSyncPayload(tenantId: string): Promise<PbxSyncPayload> {
  const [trunks, extensions, outboundRoutes, inboundRoutes] = await Promise.all([
    prisma.trunk.findMany({ where: { OR: [{ tenantId: null }, { tenantId }] }, include: { dids: true } }),
    prisma.extension.findMany({ where: { tenantId, isActive: true } }),
    prisma.outboundRoute.findMany({ where: { tenantId }, include: { permissions: { include: { extension: { select: { number: true } } } } } }),
    prisma.inboundRoute.findMany({ where: { tenantId } }),
  ]);

  return {
    tenantId,
    trunks: trunks.map((t) => ({
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      type: t.type,
      transport: t.transport,
      host: t.host,
      port: t.port,
      domain: t.domain,
      authUser: t.authUser,
      authSecret: safeDecrypt(t.authSecret),
      authName: t.authName,
      codecs: t.codecs,
      dtmfMode: t.dtmfMode,
      maxConcurrent: t.maxConcurrent,
      dids: t.dids.map((d) => d.did),
    })),
    extensions: extensions.map((e) => {
      const security = (e.security ?? {}) as { disallowIntl?: boolean };
      const presence = (e.presence ?? {}) as { ringTimeoutS?: number };
      return {
        id: e.id,
        number: e.number,
        callerId: e.callerId,
        sipAuthUser: e.sipAuthUser,
        sipAuthSecret: safeDecrypt(e.sipAuthSecret),
        maxIpRegs: e.maxIpRegs,
        disallowIntl: security.disallowIntl ?? true,
        ringTimeoutS: presence.ringTimeoutS ?? 30,
      };
    }),
    outboundRoutes: outboundRoutes.map((r) => ({
      id: r.id,
      name: r.name,
      trunkId: r.trunkId,
      dialPattern: r.dialPattern,
      callerId: r.callerId,
      priority: r.priority,
      extensionNumbers: r.permissions.map((p) => p.extension.number),
    })),
    inboundRoutes: inboundRoutes.map((r) => ({
      id: r.id,
      trunkId: r.trunkId,
      didPattern: r.didPattern,
      destType: r.destType,
      destValue: r.destValue,
    })),
  };
}

/**
 * Sincroniza a config do tenant com o motor. Fire-and-forget: regista erros
 * mas não os propaga (a mutação já foi persistida com sucesso).
 */
export async function syncTenantPbx(tenantId: string): Promise<void> {
  try {
    const payload = await buildPbxSyncPayload(tenantId);
    await getTrunkRuntime().sync(payload);
  } catch (err) {
    console.warn("[pbx-runtime] sync falhou", { tenantId, err });
  }
}

/** Wrapper não-bloqueante para usar nos handlers de rota após uma mutação. */
export function scheduleTenantPbxSync(tenantId: string): void {
  void syncTenantPbx(tenantId);
}
