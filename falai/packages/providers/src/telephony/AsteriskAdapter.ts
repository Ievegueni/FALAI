/**
 * AsteriskAdapter — Etapa 3 do docs/PLANO-INDEPENDENCIA-PBX.txt.
 *
 * Implementa o TelephonyProvider sobre o ARI (interface REST do Asterisk),
 * substituindo o YeastarAdapter no transporte das chamadas. Mesma interface,
 * por isso nem o motor de conversa nem as rotas precisam de saber qual está
 * em uso — ver §15.2 do plano.
 *
 * Eventos chegam pelo WebSocket do ARI (aplicação Stasis) e são traduzidos
 * para o CallEvent interno.
 *
 * NOTA sobre áudio: playPrompt toca ficheiros já presentes no Asterisk, tal
 * como no Yeastar. O streaming em tempo real para a IA (externalMedia) é a
 * Etapa 4 e não faz parte deste adaptador.
 */
import { WebSocket } from "ws";
import type { CallEvent } from "@falai/shared";
import type { TelephonyProvider, DialParams, PlayPromptParams } from "./TelephonyProvider.js";
import { formatDialNumber, type DialFormat } from "./asteriskNaming.js";

export interface AsteriskConfig {
  /** Ex.: http://127.0.0.1:8088 */
  baseUrl: string;
  username: string;
  password: string;
  /** Nome da aplicação Stasis que recebe as chamadas. */
  appName?: string;
  /** Contexto do dialplan usado para originar chamadas. */
  context?: string;
  /** Pasta partilhada onde se escrevem os prompts (montada no contentor). */
  soundsDir?: string;
  /**
   * Por onde sai uma chamada para a rede pública: o endpoint do trunk do
   * operador e o número a apresentar. Vem da base de dados (trunk activo) e é
   * relido de vez em quando, para uma alteração no backoffice não obrigar a
   * reiniciar a API. Sem isto, o `dial` tentava sair pela extensão de origem —
   * que não tem ligação nenhuma ao operador — e a chamada nunca saía.
   */
  resolveTrunk?: () => Promise<{ endpoint: string; callerId: string } | null>;
  /** Formato dos números entregues ao operador. Ver asteriskNaming.ts. */
  dialFormat?: DialFormat;
}

export class AsteriskError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AsteriskError";
  }
}

export class AsteriskAdapter implements TelephonyProvider {
  private ws: WebSocket | null = null;
  private handler: ((event: CallEvent) => void) | null = null;
  private closing = false;
  /** providerCallId → instante em que atendeu, para calcular a duração. */
  private answeredAt = new Map<string, number>();

  private readonly app: string;
  private readonly context: string;
  /** Trunk em cache, com o instante em que foi lido (ver TRUNK_TTL_MS). */
  private trunkCache: { value: { endpoint: string; callerId: string } | null; at: number } | null = null;

  constructor(private readonly cfg: AsteriskConfig) {
    this.app = cfg.appName ?? "falai";
    this.context = cfg.context ?? "from-internal";
  }

  /** Meio minuto: curto para alterações no backoffice pegarem depressa, longo
   *  para não ir à base de dados a cada chamada de uma campanha. */
  private static readonly TRUNK_TTL_MS = 30_000;

  private async trunk(): Promise<{ endpoint: string; callerId: string } | null> {
    if (!this.cfg.resolveTrunk) return null;
    const now = Date.now();
    if (this.trunkCache && now - this.trunkCache.at < AsteriskAdapter.TRUNK_TTL_MS) {
      return this.trunkCache.value;
    }
    try {
      const value = await this.cfg.resolveTrunk();
      this.trunkCache = { value, at: now };
      return value;
    } catch {
      // Falha a ler a base de dados não deve derrubar a chamada se já houve
      // uma leitura boa antes.
      return this.trunkCache?.value ?? null;
    }
  }

  private get auth(): string {
    return "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/ari${path}`, {
      ...init,
      headers: { Authorization: this.auth, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new AsteriskError(`ARI ${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`, res.status);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async dial(params: DialParams): Promise<{ providerCallId: string }> {
    // O canal entra directamente na aplicação Stasis: é a nossa API que
    // controla a chamada, não o dialplan.
    //
    // Um número externo sai SEMPRE pelo endpoint do trunk do operador. A
    // extensão de origem só serve para o Caller ID quando não há trunk (caso
    // das chamadas internas, entre extensões).
    const trunk = await this.trunk();
    const endpoint = trunk?.endpoint ?? params.dialPermission ?? params.fromExtension;
    const to = trunk ? formatDialNumber(params.to, this.cfg.dialFormat) : params.to;

    const q = new URLSearchParams({
      endpoint: `PJSIP/${to}@${endpoint}`,
      app: this.app,
      appArgs: params.ref,
      callerId: trunk?.callerId || params.fromExtension,
      timeout: "60",
    });
    const ch = await this.api<{ id: string }>(`/channels?${q}`, { method: "POST" });
    this.handler?.({ type: "CALL_INITIATED", providerCallId: ch.id, ref: params.ref });
    return { providerCallId: ch.id };
  }

  async hangup(providerCallId: string): Promise<void> {
    try {
      await this.api(`/channels/${encodeURIComponent(providerCallId)}`, { method: "DELETE" });
    } catch (err) {
      // 404 = já desligou. Não é erro para quem chama.
      if (!(err instanceof AsteriskError && err.status === 404)) throw err;
    }
  }

  async transfer(providerCallId: string, to: string): Promise<void> {
    const q = new URLSearchParams({ context: this.context, extension: to, priority: "1" });
    await this.api(`/channels/${encodeURIComponent(providerCallId)}/redirect?${q}`, { method: "POST" });
  }

  /**
   * No Asterisk os prompts são ficheiros no disco do motor. A API escreve-os
   * na pasta partilhada; aqui só validamos que há para onde escrever, porque
   * quem grava é o AudioCache (tem o buffer e a cache).
   */
  async uploadPrompt(_name: string, _wavBuffer: Buffer): Promise<void> {
    if (!this.cfg.soundsDir) {
      throw new AsteriskError("soundsDir não configurado — não há onde guardar os prompts");
    }
    // Escrita feita pelo AudioCache directamente na pasta partilhada.
  }

  async playPrompt(params: PlayPromptParams): Promise<void> {
    const id = params.providerCallId;
    if (!id) throw new AsteriskError("playPrompt no Asterisk exige providerCallId");

    for (let i = 0; i < (params.count ?? 1); i++) {
      for (const p of params.prompts) {
        const q = new URLSearchParams({ media: `sound:${p}` });
        await this.api(`/channels/${encodeURIComponent(id)}/play?${q}`, { method: "POST" });
      }
    }
    // O fim real chega pelo evento PlaybackFinished do ARI.
  }

  async subscribeToEvents(handler: (event: CallEvent) => void): Promise<void> {
    this.handler = handler;
    this.closing = false;
    this.connect();
  }

  private connect(): void {
    const url = this.cfg.baseUrl.replace(/^http/, "ws");
    const q = new URLSearchParams({
      app: this.app,
      subscribeAll: "true",
      api_key: `${this.cfg.username}:${this.cfg.password}`,
    });
    const ws = new WebSocket(`${url}/ari/events?${q}`);
    this.ws = ws;

    ws.on("message", (raw) => {
      try {
        this.onAriEvent(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        /* evento malformado — ignorar em vez de derrubar a ligação */
      }
    });

    // Religa sozinho: perder eventos significa chamadas presas em "a tocar".
    ws.on("close", () => {
      if (!this.closing) setTimeout(() => this.connect(), 3000);
    });
    ws.on("error", () => ws.close());
  }

  private onAriEvent(e: Record<string, unknown>): void {
    const type = e["type"] as string;
    const channel = e["channel"] as { id?: string; state?: string } | undefined;
    const id = channel?.id ?? (e["playback"] as { target_uri?: string } | undefined)?.target_uri?.split(":")[1];
    if (!id || !this.handler) return;

    switch (type) {
      case "ChannelStateChange":
        if (channel?.state === "Ringing" || channel?.state === "Ring") {
          this.handler({ type: "CALL_RINGING", providerCallId: id });
        } else if (channel?.state === "Up") {
          this.answeredAt.set(id, Date.now());
          this.handler({ type: "CALL_ANSWERED", providerCallId: id, answeredAt: new Date() });
        }
        break;

      case "StasisStart":
        this.handler({ type: "CALL_RINGING", providerCallId: id });
        break;

      case "StasisEnd":
      case "ChannelDestroyed": {
        const start = this.answeredAt.get(id);
        this.answeredAt.delete(id);
        const cause = String((e["cause_txt"] as string) ?? (e["cause"] as number) ?? "normal");
        // Sem instante de atendimento, a chamada nunca foi atendida.
        if (start === undefined) {
          this.handler({ type: "CALL_FAILED", providerCallId: id, reason: cause });
        } else {
          this.handler({
            type: "CALL_ENDED",
            providerCallId: id,
            endedAt: new Date(),
            durationSecs: Math.max(0, Math.round((Date.now() - start) / 1000)),
            hangupCause: cause,
          });
        }
        break;
      }

      case "PlaybackFinished":
        this.handler({ type: "PROMPT_FINISHED", providerCallId: id });
        break;

      case "ChannelDtmfReceived":
        this.handler({ type: "DTMF", providerCallId: id, digit: String(e["digit"] ?? "") });
        break;
    }
  }

  async unsubscribeFromEvents(): Promise<void> {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
    this.handler = null;
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      const info = await this.api<{ system?: { version?: string } }>("/asterisk/info");
      return { ok: true, details: `Asterisk ${info.system?.version ?? "?"}` };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }
}
