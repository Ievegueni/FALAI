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
import { AsteriskRuntimeAdapter, isAsteriskConfigured } from "./asteriskRuntime.service.js";

// Singleton do motor. Usa o Asterisk quando está configurado (ASTERISK_AMI_*);
// caso contrário fica no Noop, para que instalações sem motor próprio continuem
// a funcionar com o PBX externo. Ver docs/PLANO-INDEPENDENCIA-PBX.txt §15.1.
let engine: TrunkRuntimeAdapter | null = null;
export function getTrunkRuntime(): TrunkRuntimeAdapter {
  if (!engine) {
    const log = (msg: string, meta?: unknown) => console.log(`[pbx-runtime] ${msg}`, meta ?? "");
    engine = isAsteriskConfigured() ? new AsteriskRuntimeAdapter(log) : new NoopTrunkRuntimeAdapter(log);
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

/**
 * Constrói o snapshot GLOBAL: todos os trunks e as extensões activas de todos
 * os clientes activos.
 *
 * Era por tenant e estava errado — o motor tem um ficheiro só, por isso
 * sincronizar um cliente apagava as extensões dos outros. Ver a nota em
 * PbxSyncPayload (packages/providers).
 */
export async function buildPbxSyncPayload(): Promise<PbxSyncPayload> {
  const [trunks, extensions, outboundRoutes, inboundRoutes] = await Promise.all([
    prisma.trunk.findMany({ include: { dids: true } }),
    prisma.extension.findMany({
      where: { isActive: true, tenant: { status: { not: "CLOSED" }, deletedAt: null } },
      include: { tenant: { select: { name: true } } },
    }),
    prisma.outboundRoute.findMany({ include: { permissions: { include: { extension: { select: { number: true } } } } } }),
    prisma.inboundRoute.findMany(),
  ]);

  return {
    trunks: trunks.map((t) => ({
      id: t.id,
      tenantId: t.tenantId,
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
        tenantId: e.tenantId,
        tenantName: e.tenant.name,
        number: e.number,
        callerId: e.callerId,
        sipAuthUser: e.sipAuthUser,
        sipAuthSecret: safeDecrypt(e.sipAuthSecret),
        maxIpRegs: e.maxIpRegs,
        maxWebRegs: e.maxWebRegs,
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
 * Projecta a configuração inteira no motor. Uma alteração num cliente obriga a
 * reescrever tudo, porque o motor tem um ficheiro de configuração só.
 *
 * Não lança: quem chama vem de uma mutação já persistida com sucesso e não
 * deve falhar por causa do motor. Mas REGISTA em condições — um sync falhado
 * significa que o backoffice e a realidade ficaram diferentes, e isso não pode
 * passar em silêncio.
 */
export async function syncAllPbx(): Promise<void> {
  try {
    const payload = await buildPbxSyncPayload();
    const result = await getTrunkRuntime().sync(payload);
    if (!result.ok) {
      console.error("[pbx-runtime] sync NÃO aplicado — motor e backoffice estão diferentes", result.details);
    }
  } catch (err) {
    console.error("[pbx-runtime] sync falhou", err);
  }
}

/**
 * Sincroniza depois de mexer na configuração de um cliente.
 * O `tenantId` fica só para o registo: o que se projecta é sempre tudo.
 */
export async function syncTenantPbx(tenantId: string): Promise<void> {
  console.log("[pbx-runtime] sync pedido por alteração no tenant", tenantId);
  await syncAllPbx();
}

/** Wrapper não-bloqueante para usar nos handlers de rota após uma mutação. */
export function scheduleTenantPbxSync(tenantId: string): void {
  void syncTenantPbx(tenantId);
}

/** Wrapper não-bloqueante para o backoffice. */
export function scheduleAllPbxSync(): void {
  void syncAllPbx();
}
