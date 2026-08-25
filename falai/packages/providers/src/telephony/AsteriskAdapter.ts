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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
   *
   * Recebe o tenant da chamada: um trunk pode ser exclusivo de um cliente
   * (Trunk.tenantId) ou partilhado (tenantId nulo). Sem este argumento a
   * escolha era "o primeiro trunk activo", o que fazia um cliente sair pelo
   * trunk — e com o Caller ID — de outro.
   */
  resolveTrunk?: (tenantId?: string) => Promise<{ endpoint: string; callerId: string } | null>;
  /** Formato dos números entregues ao operador. Ver asteriskNaming.ts. */
  dialFormat?: DialFormat;
}

export class AsteriskError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AsteriskError";
  }
}

/**
 * "Ring group" simples para chamadas de entrada: várias pernas (ex. hardphone
 * + webphone da mesma extensão) a tocar em simultâneo. A primeira a atender
 * (ChannelStateChange → Up) dispara onAnswer; quem chama trata de desligar as
 * restantes. Se todas caírem sem ninguém atender, dispara onAllFailed.
 */
interface RingGroup {
  remaining: Set<string>;
  settled: boolean;
  onAnswer: (answeredChannelId: string) => void;
  onAllFailed: () => void;
}

export class AsteriskAdapter implements TelephonyProvider {
  private ws: WebSocket | null = null;
  private handler: ((event: CallEvent) => void) | null = null;
  private closing = false;
  /** providerCallId → instante em que atendeu, para calcular a duração. */
  private answeredAt = new Map<string, number>();
  /** channelId (perna do ring group) → grupo partilhado entre as pernas. */
  private ringGroups = new Map<string, RingGroup>();
  /**
   * Chamadas de "só tocar um áudio e desligar" (campanhas de script fixo).
   * channelId → o que falta tocar. Ver playPrompt().
   */
  private promptSessions = new Map<string, { prompts: string[]; index: number; remainingLoops: number }>();

  private readonly app: string;
  private readonly context: string;
  /** Trunk em cache, com o instante em que foi lido (ver TRUNK_TTL_MS). */
  /** Cache do trunk POR TENANT — trunks diferentes por cliente não se podem misturar. */
  private trunkCache = new Map<string, { value: { endpoint: string; callerId: string } | null; at: number }>();

  constructor(private readonly cfg: AsteriskConfig) {
    this.app = cfg.appName ?? "falai";
    this.context = cfg.context ?? "from-internal";
  }

  /** Meio minuto: curto para alterações no backoffice pegarem depressa, longo
   *  para não ir à base de dados a cada chamada de uma campanha. */
  private static readonly TRUNK_TTL_MS = 30_000;

  private async trunk(tenantId?: string): Promise<{ endpoint: string; callerId: string } | null> {
    if (!this.cfg.resolveTrunk) return null;
    const key = tenantId ?? "";
    const now = Date.now();
    const cached = this.trunkCache.get(key);
    if (cached && now - cached.at < AsteriskAdapter.TRUNK_TTL_MS) return cached.value;
    try {
      const value = await this.cfg.resolveTrunk(tenantId);
      this.trunkCache.set(key, { value, at: now });
      return value;
    } catch {
      // Falha a ler a base de dados não deve derrubar a chamada se já houve
      // uma leitura boa antes — mas só a deste tenant.
      return cached?.value ?? null;
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
    const trunk = await this.trunk(params.tenantId);
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

  /**
   * Origina um canal directamente para um endpoint PJSIP pelo NOME (ex.
   * "ext_xxx"/"extweb_xxx"), ao contrário de `dial()` que marca
   * "número@endpoint-do-trunk". Usado pelo router de chamadas de entrada
   * para tocar num ramal específico (hardphone e/ou webphone).
   */
  async originateToPjsipEndpoint(
    endpointId: string,
    appArgs: string,
    callerId: string | undefined,
    timeoutSecs: number
  ): Promise<{ id: string }> {
    const q = new URLSearchParams({
      endpoint: `PJSIP/${endpointId}`,
      app: this.app,
      appArgs,
      timeout: String(timeoutSecs),
      ...(callerId ? { callerId } : {}),
    });
    return this.api<{ id: string }>(`/channels?${q}`, { method: "POST" });
  }

  async answerChannel(providerCallId: string): Promise<void> {
    await this.api(`/channels/${encodeURIComponent(providerCallId)}/answer`, { method: "POST" });
  }

  async createBridge(): Promise<{ id: string }> {
    return this.api<{ id: string }>(`/bridges?type=mixing`, { method: "POST" });
  }

  /**
   * Larga a bridge. Sem isto cada chamada deixava uma bridge ARI viva no
   * Asterisk para sempre — incluindo as que falhavam antes de alguém atender.
   */
  async destroyBridge(bridgeId: string): Promise<void> {
    try {
      await this.api(`/bridges/${encodeURIComponent(bridgeId)}`, { method: "DELETE" });
    } catch (err) {
      // 404 = já não existe. Não é erro para quem chama.
      if (!(err instanceof AsteriskError && err.status === 404)) throw err;
    }
  }

  async addChannelToBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.api(
      `/bridges/${encodeURIComponent(bridgeId)}/addChannel?channel=${encodeURIComponent(channelId)}`,
      { method: "POST" }
    );
  }

  /** Ver RingGroup — regista as pernas de uma chamada de entrada com destino a mais de um endpoint. */
  registerRingGroup(
    memberChannelIds: string[],
    onAnswer: (answeredChannelId: string) => void,
    onAllFailed: () => void
  ): void {
    const group: RingGroup = { remaining: new Set(memberChannelIds), settled: false, onAnswer, onAllFailed };
    for (const id of memberChannelIds) this.ringGroups.set(id, group);
  }

  /**
   * Sem rota conhecida (ou destino ainda não suportado) para uma chamada de
   * entrada — toca um aviso em vez de deixar a chamada morrer em silêncio,
   * espelhando o "sem_trunk" já existente no dialplan de saída.
   */
  async noRouteFallback(providerCallId: string): Promise<void> {
    try {
      await this.answerChannel(providerCallId);
      await this.playPrompt({ providerCallId, number: "", prompts: ["ss-noservice"] });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } finally {
      await this.hangup(providerCallId).catch(() => {});
    }
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
  /**
   * Grava o WAV na pasta de sons partilhada com o contentor. Antes isto era um
   * no-op com um comentário a dizer que o AudioCache escrevia o ficheiro — o
   * que não acontecia. Resultado: as campanhas de script fixo tentavam tocar um
   * áudio que nunca existiu.
   */
  async uploadPrompt(name: string, wavBuffer: Buffer): Promise<void> {
    if (!this.cfg.soundsDir) {
      throw new AsteriskError("soundsDir não configurado — não há onde guardar os prompts");
    }
    await mkdir(this.cfg.soundsDir, { recursive: true });
    await writeFile(join(this.cfg.soundsDir, `${name}.wav`), wavBuffer);
  }

  /**
   * Nome com que o Asterisk conhece um prompt nosso. A pasta partilhada está
   * montada em /var/lib/asterisk/sounds/custom, e é assim que o ARI a resolve.
   */
  private mediaFor(prompt: string): string {
    return `sound:custom/${prompt}`;
  }

  /**
   * Toca prompts numa chamada. Dois modos:
   *   - com `providerCallId`: toca num canal que já existe (fluxo do agente IA);
   *   - com `number`: origina a chamada, espera que atendam, toca e desliga.
   *
   * O segundo modo é o das campanhas de script fixo. Existia na interface
   * (herdada do Yeastar, onde o PBX faz tudo isto sozinho) mas aqui atirava
   * "playPrompt no Asterisk exige providerCallId" — ou seja, nenhuma campanha
   * de script fixo chegava a ligar seja a quem for.
   */
  async playPrompt(params: PlayPromptParams): Promise<void> {
    const id = params.providerCallId;
    if (!id) {
      if (!params.number) {
        throw new AsteriskError("playPrompt exige providerCallId ou number");
      }
      const { providerCallId } = await this.dial({
        fromExtension: params.dialPermission ?? "",
        to: params.number,
        ref: `prompt_${Date.now()}`,
        autoAnswer: "no",
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      });
      // O áudio só arranca quando atenderem — ver handleEvent, ramo "Up".
      this.promptSessions.set(providerCallId, {
        prompts: params.prompts,
        index: 0,
        remainingLoops: params.count ?? 1,
      });
      return;
    }

    for (let i = 0; i < (params.count ?? 1); i++) {
      for (const p of params.prompts) {
        const q = new URLSearchParams({ media: this.mediaFor(p) });
        await this.api(`/channels/${encodeURIComponent(id)}/play?${q}`, { method: "POST" });
      }
    }
    // O fim real chega pelo evento PlaybackFinished do ARI.
  }

  /** Toca o próximo prompt de uma chamada de script fixo; desliga no fim. */
  private advancePromptSession(channelId: string): void {
    const s = this.promptSessions.get(channelId);
    if (!s) return;

    if (s.index >= s.prompts.length) {
      s.remainingLoops -= 1;
      s.index = 0;
      if (s.remainingLoops <= 0) {
        this.promptSessions.delete(channelId);
        void this.hangup(channelId).catch(() => {});
        return;
      }
    }

    const prompt = s.prompts[s.index++]!;
    const q = new URLSearchParams({ media: this.mediaFor(prompt) });
    void this.api(`/channels/${encodeURIComponent(channelId)}/play?${q}`, { method: "POST" }).catch(() => {
      // Falhar a tocar não pode deixar a chamada aberta a custar dinheiro.
      this.promptSessions.delete(channelId);
      void this.hangup(channelId).catch(() => {});
    });
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
    const channel = e["channel"] as
      | { id?: string; state?: string; caller?: { number?: string } }
      | undefined;
    const id = channel?.id ?? (e["playback"] as { target_uri?: string } | undefined)?.target_uri?.split(":")[1];
    if (!id || !this.handler) return;

    switch (type) {
      case "ChannelStateChange":
        if (channel?.state === "Ringing" || channel?.state === "Ring") {
          this.handler({ type: "CALL_RINGING", providerCallId: id });
        } else if (channel?.state === "Up") {
          // Perna de um ring group (secção 6 do plano do webphone): a
          // primeira a atender ganha, não é uma "chamada" genérica do
          // call engine — não emitir CALL_ANSWERED para isto.
          const ring = this.ringGroups.get(id);
          if (ring && !ring.settled) {
            ring.settled = true;
            for (const memberId of ring.remaining) this.ringGroups.delete(memberId);
            ring.onAnswer(id);
            break;
          }
          // Campanha de script fixo: atenderam, começa o áudio.
          if (this.promptSessions.has(id)) {
            this.answeredAt.set(id, Date.now());
            this.advancePromptSession(id);
            break;
          }
          this.answeredAt.set(id, Date.now());
          this.handler({ type: "CALL_ANSWERED", providerCallId: id, answeredAt: new Date() });
        }
        break;

      case "StasisStart": {
        // args[0] === "inbound" identifica um canal que chegou do dialplan
        // (Stasis(falai,inbound,${EXTEN}[,tenantId])) — ainda não corresponde a
        // nenhuma sessão nossa, ao contrário de um canal que nós originámos via
        // dial(). Ver extensions.conf.template e o ficheiro de contextos gerado.
        //
        // args[2], quando existe, é o tenant dono do trunk por onde a chamada
        // entrou. Só vem nos trunks exclusivos de um cliente (peering por IP);
        // num trunk partilhado não há resposta a dar aqui e o tenant resolve-se
        // pelo DID, mais à frente.
        const args = (e["args"] as string[] | undefined) ?? [];
        if (args[0] === "inbound") {
          const callerIdNum = channel?.caller?.number;
          const tenantId = args[2];
          this.handler({
            type: "INBOUND_CALL_STARTED",
            providerCallId: id,
            did: args[1] ?? "",
            ...(callerIdNum ? { callerIdNum } : {}),
            ...(tenantId ? { tenantId } : {}),
          });
        } else {
          this.handler({ type: "CALL_RINGING", providerCallId: id });
        }
        break;
      }

      case "StasisEnd":
      case "ChannelDestroyed": {
        // Perna de ring group que caiu (timeout ou nós próprios a desligar as
        // que perderam) — não tem sessão de call engine associada, só
        // contabiliza para saber se TODAS falharam.
        const ring = this.ringGroups.get(id);
        if (ring) {
          this.ringGroups.delete(id);
          ring.remaining.delete(id);
          if (!ring.settled && ring.remaining.size === 0) {
            ring.settled = true;
            ring.onAllFailed();
          }
          break;
        }

        this.promptSessions.delete(id);
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
        // Script fixo: encadeia o prompt seguinte (ou desliga) sem envolver o
        // motor de IA, que não tem sessão para esta chamada.
        if (this.promptSessions.has(id)) {
          this.advancePromptSession(id);
          break;
        }
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
