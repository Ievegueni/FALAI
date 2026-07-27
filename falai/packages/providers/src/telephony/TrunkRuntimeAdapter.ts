/**
 * Motor de chamadas (call engine) — Fase 4 do módulo PBX nativo (docs/sip_trunk.md §0).
 *
 * A config do Falaí (Extension/Trunk/rotas) é a fonte de verdade. Este adaptador
 * traduz essa config para o motor SIP real (Asterisk/FreeSWITCH/drachtio/…) que
 * regista o trunk no provider e origina/recebe RTP. `sync()` é chamado sempre
 * que a config muda; o motor é regenerado a partir dela, nunca editado à mão.
 *
 * Tipos neutros (sem Prisma) para o adaptador ser independente do schema.
 */

export interface SipTrunkConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: "REGISTER" | "PEER";
  transport: "UDP" | "TCP" | "TLS";
  host: string;
  port: number;
  domain: string | null;
  authUser: string;
  /** Segredo em texto (já desencriptado). O adaptador entrega-o ao motor. */
  authSecret: string;
  authName: string | null;
  codecs: string[];
  dtmfMode: string;
  maxConcurrent: number | null;
  dids: string[];
}

export interface SipExtensionConfig {
  id: string;
  number: string;
  callerId: string;
  sipAuthUser: string;
  /** Segredo de registo em texto (já desencriptado). */
  sipAuthSecret: string;
  maxIpRegs: number;
  disallowIntl: boolean;
  ringTimeoutS: number;
}

export interface OutboundRouteConfig {
  id: string;
  name: string;
  trunkId: string;
  dialPattern: string | null;
  callerId: string | null;
  priority: number;
  extensionNumbers: string[];
}

export interface InboundRouteConfig {
  id: string;
  trunkId: string;
  didPattern: string;
  destType: string;
  destValue: string;
}

/** Snapshot completo da config de um tenant, pronto a materializar no motor. */
export interface PbxSyncPayload {
  tenantId: string;
  trunks: SipTrunkConfig[];
  extensions: SipExtensionConfig[];
  outboundRoutes: OutboundRouteConfig[];
  inboundRoutes: InboundRouteConfig[];
}

export interface PbxSyncResult {
  ok: boolean;
  engine: string;
  details?: string;
}

export interface TrunkRuntimeAdapter {
  /** Materializa a config no motor (idempotente). */
  sync(payload: PbxSyncPayload): Promise<PbxSyncResult>;
  /** Estado do motor. */
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}

/**
 * Stub sem motor. Regista o que faria e devolve ok — permite ter as Fases 1–3
 * ligadas end-to-end (a UI/API chamam `sync`) antes de escolher o motor real.
 * Substituir por AsteriskAdapter/FreeSwitchAdapter/DrachtioAdapter na Fase 4.
 */
export class NoopTrunkRuntimeAdapter implements TrunkRuntimeAdapter {
  constructor(private readonly log?: (msg: string, meta?: unknown) => void) {}

  async sync(payload: PbxSyncPayload): Promise<PbxSyncResult> {
    this.log?.("pbx.runtime.sync (noop)", {
      tenantId: payload.tenantId,
      trunks: payload.trunks.length,
      extensions: payload.extensions.length,
      outboundRoutes: payload.outboundRoutes.length,
      inboundRoutes: payload.inboundRoutes.length,
    });
    return { ok: true, engine: "noop" };
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    return { ok: true, details: "noop engine (config-only mode)" };
  }
}
