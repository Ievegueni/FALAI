/**
 * Supervisão de chamadas em tempo real (melhoria 4/4) sobre o ARI.
 *
 *   Escuta       snoop no canal do agente (spy=both, whisper=none) + supervisor
 *                numa bridge própria "supervise-<sessão>"
 *   Sussurro     igual, mas whisper=out — o áudio do supervisor chega só ao agente
 *   Intervenção  o canal do supervisor entra na bridge da conversa (mistura a 3)
 *
 * Trocar de modo não desliga o supervisor: troca-se o snoop, ou o canal dele
 * passa de uma bridge para a outra. Terminar nunca toca na bridge da conversa —
 * agente e cliente continuam. Se o cliente ou o agente desligarem, a sessão
 * termina sozinha (eventos do ARI). Tudo o que a sessão cria (snoop, bridge,
 * canais do supervisor) é limpo em qualquer saída; o que sobrar de um
 * reinício é varrido no arranque (sweepOrphans).
 *
 * ponytail: sessões em memória — uma só instância da API (tal como o router de
 * entrada); com várias, passar para Redis.
 */
import { randomUUID } from "node:crypto";
import type { CallEvent } from "@falai/shared";
import type { AsteriskAdapter } from "@falai/providers";
import type { ActiveInboundCall } from "./inboundCallRouter.service.js";

export type SupervisionMode = "LISTEN" | "WHISPER" | "BARGE";
export type EndReason = "SUPERVISOR" | "CALL_ENDED" | "SUPERVISOR_HUNGUP" | "SUPERVISOR_NO_ANSWER" | "ERROR";

type Ari = Pick<
  AsteriskAdapter,
  | "createBridge"
  | "destroyBridge"
  | "addChannelToBridge"
  | "removeChannelFromBridge"
  | "snoopChannel"
  | "originateToPjsipEndpoint"
  | "registerRingGroup"
  | "hangup"
  | "listBridges"
>;

export interface SupervisionAuditEvent {
  sessionId: string;
  tenantId: string;
  type: "START" | "MODE" | "END";
  mode?: SupervisionMode;
  supervisorId: string;
  agentExtensionId: string;
  callId: string;
  endReason?: EndReason;
}

export interface SupervisionDeps {
  asterisk: Ari;
  /** Escreve no registo imutável (SupervisionEvent). */
  audit: (e: SupervisionAuditEvent) => Promise<void>;
  /** Avisa o webphone do agente (mode null = a supervisão acabou). */
  notifyAgent: (tenantId: string, extensionId: string, mode: SupervisionMode | null) => void;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

export interface Session {
  id: string;
  tenantId: string;
  call: ActiveInboundCall;
  supervisorId: string;
  status: "CONNECTING" | "ACTIVE";
  mode: SupervisionMode;
  bridgeId: string;
  supervisorChannels: string[]; // a tocar (hardphone + webphone)
  supervisorChannel?: string; // o que atendeu
  snoopId?: string | undefined;
  inConversation: boolean; // Intervenção: o supervisor está na bridge da conversa
}

export class SupervisionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const SUPERVISE_BRIDGE_PREFIX = "supervise-";

export class SupervisionManager {
  private sessions = new Map<string, Session>();
  /** canal (cliente, agente ou supervisor) → sessão; o fim de qualquer um termina-a. */
  private byChannel = new Map<string, string>();

  constructor(private deps: SupervisionDeps) {}

  /** Sessão activa numa chamada (no máximo uma). */
  forCall(callId: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.call.callId === callId) return s;
    return undefined;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Começa a supervisão: liga para a extensão do supervisor e, quando ele
   * atender, entra no modo pedido. As permissões (papel, grupos) verificam-se
   * na rota; aqui ficam as regras da chamada.
   */
  async start(params: {
    call: ActiveInboundCall;
    supervisorId: string;
    supervisorExtensionId: string;
    supervisorEndpoints: string[];
    mode: SupervisionMode;
  }): Promise<Session> {
    const { call } = params;
    if (params.supervisorExtensionId === call.agentExtensionId) {
      throw new SupervisionError("Não pode supervisionar a própria chamada", 403);
    }
    if (this.forCall(call.callId)) throw new SupervisionError("Esta chamada já está a ser supervisionada", 409);

    const id = randomUUID();
    const bridge = await this.deps.asterisk.createBridge(`${SUPERVISE_BRIDGE_PREFIX}${id}`);
    const s: Session = {
      id,
      tenantId: call.tenantId,
      call,
      supervisorId: params.supervisorId,
      status: "CONNECTING",
      mode: params.mode,
      bridgeId: bridge.id,
      supervisorChannels: [],
      inConversation: false,
    };
    this.sessions.set(id, s);
    this.byChannel.set(call.callerChannelId, id);
    this.byChannel.set(call.agentChannelId, id);

    // O webphone atende sozinho quando vê X-Falai-Supervise (ver WebphoneContext).
    const variables = { "PJSIP_HEADER(add,X-Falai-Supervise)": id };
    const channels = await Promise.all(
      params.supervisorEndpoints.map((ep) =>
        this.deps.asterisk
          .originateToPjsipEndpoint(ep, `supervise:${id}`, "Supervisao", 30, variables)
          .then((c) => c.id)
          .catch(() => null)
      )
    );
    s.supervisorChannels = channels.filter((c): c is string => c !== null);
    if (s.supervisorChannels.length === 0) {
      await this.end(id, "SUPERVISOR_NO_ANSWER");
      throw new SupervisionError("A extensão do supervisor não está registada", 409);
    }
    for (const c of s.supervisorChannels) this.byChannel.set(c, id);

    this.deps.asterisk.registerRingGroup(
      s.supervisorChannels,
      (answered) => void this.onSupervisorAnswered(id, answered),
      () => void this.end(id, "SUPERVISOR_NO_ANSWER")
    );
    return s;
  }

  private async onSupervisorAnswered(id: string, channelId: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const c of s.supervisorChannels) {
      if (c !== channelId) {
        this.byChannel.delete(c);
        this.deps.asterisk.hangup(c).catch(() => {});
      }
    }
    s.supervisorChannels = [channelId];
    s.supervisorChannel = channelId;
    try {
      await this.deps.asterisk.addChannelToBridge(s.bridgeId, channelId);
      await this.apply(s, s.mode);
      s.status = "ACTIVE";
      await this.deps.audit(this.event(s, "START", s.mode));
      this.notify(s, s.mode);
    } catch (err) {
      this.deps.log.error({ err, sessionId: id }, "supervision.start_failed");
      await this.end(id, "ERROR");
    }
  }

  /** Muda de modo sem desligar o supervisor. */
  async setMode(id: string, mode: SupervisionMode): Promise<Session> {
    const s = this.sessions.get(id);
    if (!s) throw new SupervisionError("Supervisão não encontrada", 404);
    if (s.mode === mode) return s;
    if (s.status !== "ACTIVE") {
      s.mode = mode; // ainda a ligar ao supervisor: entra já no modo novo
      return s;
    }
    await this.apply(s, mode);
    s.mode = mode;
    await this.deps.audit(this.event(s, "MODE", mode));
    this.notify(s, mode);
    return s;
  }

  /** Põe o áudio no modo pedido. O supervisor já atendeu (supervisorChannel). */
  private async apply(s: Session, mode: SupervisionMode): Promise<void> {
    const a = this.deps.asterisk;
    const sup = s.supervisorChannel!;
    if (mode === "BARGE") {
      await this.dropSnoop(s);
      await a.removeChannelFromBridge(s.bridgeId, sup);
      await a.addChannelToBridge(s.call.bridgeId, sup);
      s.inConversation = true;
      return;
    }
    if (s.inConversation) {
      await a.removeChannelFromBridge(s.call.bridgeId, sup);
      await a.addChannelToBridge(s.bridgeId, sup);
      s.inConversation = false;
    }
    // Snoop novo antes de largar o velho: a escuta não tem buraco.
    const old = s.snoopId;
    const snoop = await a.snoopChannel(s.call.agentChannelId, {
      spy: "both",
      whisper: mode === "WHISPER" ? "out" : "none",
      appArgs: `supervise:${s.id}`,
    });
    await a.addChannelToBridge(s.bridgeId, snoop.id);
    s.snoopId = snoop.id;
    if (old) await a.hangup(old).catch(() => {});
  }

  private async dropSnoop(s: Session): Promise<void> {
    if (!s.snoopId) return;
    const id = s.snoopId;
    s.snoopId = undefined;
    await this.deps.asterisk.hangup(id).catch(() => {});
  }

  /**
   * Termina e limpa tudo o que a sessão criou. Idempotente. Nunca toca na
   * bridge da conversa nem nos canais do cliente e do agente.
   */
  async end(id: string, reason: EndReason): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    for (const [ch, sid] of this.byChannel) if (sid === id) this.byChannel.delete(ch);

    const a = this.deps.asterisk;
    if (s.inConversation && s.supervisorChannel) {
      await a.removeChannelFromBridge(s.call.bridgeId, s.supervisorChannel).catch(() => {});
    }
    await this.dropSnoop(s);
    await Promise.all(s.supervisorChannels.map((c) => a.hangup(c).catch(() => {})));
    await a.destroyBridge(s.bridgeId).catch(() => {});

    if (s.status === "ACTIVE") {
      await this.deps.audit(this.event(s, "END", s.mode, reason)).catch(() => {});
      this.notify(s, null);
    }
    this.deps.log.info({ sessionId: id, callId: s.call.callId, reason }, "supervision.ended");
  }

  /** Fim de qualquer canal da sessão (cliente, agente ou supervisor). */
  async onCallEvent(event: CallEvent): Promise<void> {
    if (event.type !== "CALL_ENDED" && event.type !== "CALL_FAILED") return;
    const id = this.byChannel.get(event.providerCallId);
    if (!id) return;
    const s = this.sessions.get(id);
    if (!s) return;
    const isSupervisor = s.supervisorChannels.includes(event.providerCallId);
    // Uma perna do supervisor que perdeu (a outra atendeu) não acaba nada.
    if (isSupervisor && s.supervisorChannel && event.providerCallId !== s.supervisorChannel) return;
    // Ainda a tocar ao supervisor: quem decide é o ring group (onAllFailed).
    if (isSupervisor && !s.supervisorChannel) return;
    await this.end(id, isSupervisor ? "SUPERVISOR_HUNGUP" : "CALL_ENDED");
  }

  /** Bridges de supervisão que sobraram de um reinício da API. */
  async sweepOrphans(): Promise<number> {
    const a = this.deps.asterisk;
    const orphans = (await a.listBridges()).filter(
      (b) => b.name.startsWith(SUPERVISE_BRIDGE_PREFIX) && !this.sessions.has(b.name.slice(SUPERVISE_BRIDGE_PREFIX.length))
    );
    for (const b of orphans) {
      await Promise.all(b.channels.map((c) => a.hangup(c).catch(() => {})));
      await a.destroyBridge(b.id).catch(() => {});
    }
    return orphans.length;
  }

  private notify(s: Session, mode: SupervisionMode | null): void {
    try {
      this.deps.notifyAgent(s.tenantId, s.call.agentExtensionId, mode);
    } catch {
      /* aviso é best-effort */
    }
  }

  private event(s: Session, type: "START" | "MODE" | "END", mode: SupervisionMode, endReason?: EndReason): SupervisionAuditEvent {
    return {
      sessionId: s.id,
      tenantId: s.tenantId,
      type,
      mode,
      supervisorId: s.supervisorId,
      agentExtensionId: s.call.agentExtensionId,
      callId: s.call.callId,
      ...(endReason && { endReason }),
    };
  }
}
