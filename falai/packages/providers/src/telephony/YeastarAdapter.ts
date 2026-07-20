import axios, { type AxiosInstance } from "axios";
import FormData from "form-data";
import type { Redis } from "ioredis";
import type { CallEvent } from "@falai/shared";
import { YEASTAR_EVENTS } from "@falai/shared";
import type { TelephonyProvider, DialParams, PlayPromptParams } from "./TelephonyProvider.js";

const TOKEN_KEY_BASE = "yeastar:token";
const TOKEN_REFRESH_MS = 25 * 60 * 1000;

export interface YeastarConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  userAgent?: string;
  stubMode?: boolean;
  /** Sufixo para a chave de token no Redis (isola PBX por tenant). Ex.: "tenant:abc" → yeastar:token:tenant:abc */
  instanceId?: string;
  /** Delays for stub event simulation (ms). Defaults: ringing=800, answered=2500, promptFinished=1800 */
  stubDelays?: { ringing?: number; answered?: number; promptFinished?: number };
}

interface YeastarToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface YeastarResponse<T = unknown> {
  errcode: number;
  errmsg: string;
  data?: T;
}

// Registo de CDR devolvido por /openapi/v1.0/cdr/list (campos usados; a Yeastar devolve mais)
export interface YeastarCdrRecord {
  id?: string | number;
  uid?: string;
  time?: string; // "2025/12/19 10:40:07"
  timestamp?: string | number; // epoch (quando presente)
  call_from?: string;
  call_to?: string;
  call_from_number?: string;
  call_to_number?: string;
  duration?: number;
  ring_duration?: number;
  talk_duration?: number;
  disposition?: string; // ANSWERED | NO ANSWER | BUSY | FAILED | VOICEMAIL
  call_type?: string; // Inbound | Outbound | Internal
  record_file?: string;
}

// A resposta de get_token/refresh_token traz os tokens no nível de topo
interface YeastarTokenResponse {
  errcode: number;
  errmsg: string;
  access_token: string;
  access_token_expire_time?: number;
  refresh_token: string;
  refresh_token_expire_time?: number;
}

export class YeastarAdapter implements TelephonyProvider {
  private http: AxiosInstance;
  private redis: Redis;
  private config: YeastarConfig;
  private eventHandler: ((event: CallEvent) => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tokenKey: string;

  constructor(config: YeastarConfig, redis: Redis) {
    this.config = config;
    this.redis = redis;
    this.tokenKey = config.instanceId ? `${TOKEN_KEY_BASE}:${config.instanceId}` : TOKEN_KEY_BASE;
    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ""),
      headers: {
        "User-Agent": config.userAgent ?? "OpenAPI",
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const cached = await this.redis.get(this.tokenKey);
    if (cached) {
      const token: YeastarToken = JSON.parse(cached) as YeastarToken;
      if (token.expires_at > Date.now() + 60_000) return token.access_token;
      return this.refreshToken(token.refresh_token);
    }
    return this.fetchNewToken();
  }

  private async fetchNewToken(): Promise<string> {
    if (this.config.stubMode) {
      const stub: YeastarToken = {
        access_token: "stub_access_token",
        refresh_token: "stub_refresh_token",
        expires_at: Date.now() + 30 * 60 * 1000,
      };
      await this.storeToken(stub);
      return stub.access_token;
    }
    // Yeastar P-Series: campos username/password (Client ID/Secret), tokens no nível de topo
    const res = await this.http.post<YeastarTokenResponse>(
      "/openapi/v1.0/get_token",
      { username: this.config.clientId, password: this.config.clientSecret }
    );
    this.assertOk(res.data);
    const ttlSecs = res.data.access_token_expire_time ?? 30 * 60;
    const token: YeastarToken = {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      expires_at: Date.now() + ttlSecs * 1000,
    };
    await this.storeToken(token);
    return token.access_token;
  }

  private async refreshToken(refreshToken: string): Promise<string> {
    if (this.config.stubMode) return this.fetchNewToken();
    const res = await this.http.post<YeastarTokenResponse>(
      "/openapi/v1.0/refresh_token",
      { refresh_token: refreshToken }
    );
    // Se o refresh_token expirou, obtém um par novo do zero
    if (res.data.errcode !== 0) return this.fetchNewToken();
    const ttlSecs = res.data.access_token_expire_time ?? 30 * 60;
    const token: YeastarToken = {
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      expires_at: Date.now() + ttlSecs * 1000,
    };
    await this.storeToken(token);
    return token.access_token;
  }

  private async storeToken(token: YeastarToken): Promise<void> {
    await this.redis.set(this.tokenKey, JSON.stringify(token), "PX", 31 * 60 * 1000);
    this.scheduleProactiveRefresh(token.refresh_token);
  }

  private scheduleProactiveRefresh(refreshToken: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshToken(refreshToken).catch(console.error);
    }, TOKEN_REFRESH_MS);
  }

  // Yeastar P-Series espera o token como query param `?access_token=`, não em header
  private tokenParam(token: string) {
    return { params: { access_token: token } };
  }

  // ── Stub helpers ──────────────────────────────────────────────────────────

  private stubDelayMs(key: "ringing" | "answered" | "promptFinished"): number {
    const defaults = { ringing: 800, answered: 2500, promptFinished: 1800 };
    return this.config.stubDelays?.[key] ?? defaults[key];
  }

  private fireEvent(event: CallEvent, delayMs: number): void {
    setTimeout(() => {
      this.eventHandler?.(event);
    }, delayMs);
  }

  // ── Core operations ───────────────────────────────────────────────────────

  async dial(params: DialParams): Promise<{ providerCallId: string }> {
    if (this.config.stubMode) {
      const stubId = `stub_${Date.now()}_${params.ref}`;
      console.info(`[YeastarAdapter STUB] dial → to=${params.to} providerCallId=${stubId}`);
      // Simulate call progression
      this.fireEvent({ type: "CALL_RINGING", providerCallId: stubId }, this.stubDelayMs("ringing"));
      this.fireEvent(
        { type: "CALL_ANSWERED", providerCallId: stubId, answeredAt: new Date() },
        this.stubDelayMs("answered")
      );
      return { providerCallId: stubId };
    }
    const token = await this.getToken();
    const res = await this.http.post<YeastarResponse & { call_id: string }>(
      "/openapi/v1.0/call/dial",
      {
        caller: params.fromExtension,
        callee: params.to,
        dial_permission: params.dialPermission ?? params.fromExtension,
        auto_answer: params.autoAnswer ?? "yes",
      },
      this.tokenParam(token)
    );
    this.assertOk(res.data);
    // call_id vem no nível de topo da resposta, não sob `data`
    return { providerCallId: res.data.call_id };
  }

  async hangup(providerCallId: string): Promise<void> {
    if (this.config.stubMode) {
      console.info(`[YeastarAdapter STUB] hangup → ${providerCallId}`);
      const durationSecs = Math.floor((Date.now() % 100) + 10); // deterministic stub value
      this.fireEvent(
        { type: "CALL_ENDED", providerCallId, endedAt: new Date(), durationSecs, hangupCause: "NORMAL_CLEARING" },
        200
      );
      return;
    }
    const token = await this.getToken();
    const res = await this.http.post<YeastarResponse>(
      "/openapi/v1.0/call/hangup",
      { call_id: providerCallId },
      this.tokenParam(token)
    );
    this.assertOk(res.data);
  }

  async transfer(providerCallId: string, to: string): Promise<void> {
    if (this.config.stubMode) {
      console.info(`[YeastarAdapter STUB] transfer → ${providerCallId} to=${to}`);
      return;
    }
    const token = await this.getToken();
    const res = await this.http.post<YeastarResponse>(
      "/openapi/v1.0/call/transfer",
      { call_id: providerCallId, transfer_to: to },
      this.tokenParam(token)
    );
    this.assertOk(res.data);
  }

  async uploadPrompt(name: string, wavBuffer: Buffer): Promise<void> {
    if (this.config.stubMode) {
      console.info(`[YeastarAdapter STUB] uploadPrompt → name=${name} size=${wavBuffer.length}`);
      return;
    }
    const token = await this.getToken();
    const safeName = name.replace(/\.[^.]+$/, "");
    const form = new FormData();
    // A API do Yeastar deriva o nome do prompt do nome do ficheiro no multipart.
    // is_check="force" sobrepõe um prompt existente com o mesmo nome.
    form.append("file", wavBuffer, { filename: `${safeName}.wav`, contentType: "audio/wav" });
    form.append("is_check", "force");
    const res = await this.http.post<YeastarResponse>(
      "/openapi/v1.0/custom_prompt/upload",
      form,
      { headers: { ...form.getHeaders() }, params: { access_token: token } }
    );
    this.assertOk(res.data);
  }

  async playPrompt(params: PlayPromptParams): Promise<void> {
    if (this.config.stubMode) {
      console.info(`[YeastarAdapter STUB] playPrompt → number=${params.number} prompts=${params.prompts.join(",")}`);
      if (params.providerCallId) {
        this.fireEvent({ type: "PROMPT_FINISHED", providerCallId: params.providerCallId }, this.stubDelayMs("promptFinished"));
      }
      return;
    }
    const token = await this.getToken();
    const safePrompts = params.prompts.map((p) => p.replace(/\.[^.]+$/, ""));
    const res = await this.http.post<YeastarResponse>(
      "/openapi/v1.0/call/play_prompt",
      {
        number: params.number,
        prompts: safePrompts,
        volume: params.volume ?? 5,
        ...(params.count && { count: params.count }),
        ...(params.dialPermission && { dial_permission: params.dialPermission }),
        ...(params.autoAnswer && { auto_answer: params.autoAnswer }),
      },
      this.tokenParam(token)
    );
    this.assertOk(res.data);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async subscribeToEvents(handler: (event: CallEvent) => void): Promise<void> {
    this.eventHandler = handler;
    if (this.config.stubMode) {
      console.info("[YeastarAdapter STUB] subscribeToEvents registered");
    }
  }

  async unsubscribeFromEvents(): Promise<void> {
    this.eventHandler = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  handleRawEvent(payload: Record<string, unknown>): void {
    if (!this.eventHandler) return;
    const event = this.normalizeEvent(payload);
    if (event) this.eventHandler(event);
  }

  handleWebhookEvent(payload: Record<string, unknown>): void {
    this.handleRawEvent(payload);
  }

  private normalizeEvent(raw: Record<string, unknown>): CallEvent | null {
    const code = raw["event"] as number | undefined;
    const callId = (raw["call_id"] ?? raw["callid"]) as string | undefined;
    if (!callId) return null;

    switch (code) {
      case YEASTAR_EVENTS.CALL_STATE_CHANGED: {
        const state = raw["state"] as string | undefined;
        if (state === "RINGING") return { type: "CALL_RINGING", providerCallId: callId };
        if (state === "ANSWERED") return { type: "CALL_ANSWERED", providerCallId: callId, answeredAt: new Date() };
        return null;
      }
      case YEASTAR_EVENTS.CALL_END:
        return {
          type: "CALL_ENDED",
          providerCallId: callId,
          endedAt: new Date(),
          durationSecs: (raw["duration"] as number | undefined) ?? 0,
          hangupCause: (raw["hangup_cause"] as string | undefined) ?? "NORMAL_CLEARING",
        };
      case YEASTAR_EVENTS.CALL_FAILURE:
        return { type: "CALL_FAILED", providerCallId: callId, reason: (raw["reason"] as string | undefined) ?? "UNKNOWN" };
      case YEASTAR_EVENTS.PROMPT_PLAYBACK_COMPLETED:
        return { type: "PROMPT_FINISHED", providerCallId: callId };
      case YEASTAR_EVENTS.DTMF_DIGIT:
        return { type: "DTMF", providerCallId: callId, digit: String(raw["digit"] ?? "") };
      default:
        return null;
    }
  }

  /** Verifica se uma chamada pelo providerCallId ainda está activa no PBX. */
  async isCallActive(providerCallId: string): Promise<boolean> {
    const state = await this.getCallState(providerCallId);
    return state !== null;
  }

  /**
   * Devolve o estado actual de uma chamada activa no PBX.
   * Retorna null se a chamada não existir (já terminou ou nunca foi criada).
   * Os valores de state conhecidos: "RINGING", "ANSWERED", "HOLDING".
   */
  async getCallState(providerCallId: string): Promise<{ state: string } | null> {
    if (this.config.stubMode) return { state: "ANSWERED" };
    try {
      const token = await this.getToken();
      const res = await this.http.get<YeastarResponse<Array<{ call_id?: string; callid?: string; state?: string }>>>(
        "/openapi/v1.0/call/query",
        { params: { access_token: token } }
      );
      if (res.data.errcode !== 0) return null;
      const found = (res.data.data ?? []).find((c) => (c.call_id ?? c.callid) === providerCallId);
      if (!found) return null;
      return { state: (found.state ?? "UNKNOWN").toUpperCase() };
    } catch {
      return null;
    }
  }

  /** Lista as extensões do PBX (número + nome). Usado para chamadas directas. */
  async listExtensions(): Promise<Array<{ number: string; name: string }>> {
    if (this.config.stubMode) {
      return ["1000", "1001", "1002", "1003", "1004"].map((n) => ({ number: n, name: n }));
    }
    const token = await this.getToken();
    const res = await this.http.get<YeastarResponse<Array<{ number: string; caller_id_name?: string }>>>(
      "/openapi/v1.0/extension/list",
      { params: { page: 1, page_size: 100, access_token: token } }
    );
    this.assertOk(res.data);
    return (res.data.data ?? []).map((e) => ({ number: e.number, name: e.caller_id_name || e.number }));
  }

  /** Busca o CDR (histórico de chamadas) do PBX. Usado para o produto CRM (BYO-PBX). */
  async getCdr(params?: { page?: number; pageSize?: number }): Promise<{ total: number; records: YeastarCdrRecord[] }> {
    if (this.config.stubMode) return { total: 0, records: [] };
    const token = await this.getToken();
    const res = await this.http.get<YeastarResponse<YeastarCdrRecord[]> & { total_number?: number }>(
      "/openapi/v1.0/cdr/list",
      {
        params: {
          page: params?.page ?? 1,
          page_size: params?.pageSize ?? 200,
          sort_by: "time",
          order_by: "desc",
          access_token: token,
        },
      }
    );
    this.assertOk(res.data);
    return { total: res.data.total_number ?? 0, records: res.data.data ?? [] };
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.config.stubMode) return { ok: true, details: "stub mode" };
    try {
      const token = await this.getToken();
      const cached = await this.redis.get(this.tokenKey);
      if (!cached) return { ok: false, details: "token not cached" };
      const res = await this.http.get<YeastarResponse>(
        "/openapi/v1.0/extension/list",
        { params: { page: 1, page_size: 1, access_token: token } }
      );
      return { ok: res.data.errcode === 0, details: res.data.errmsg };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }

  private assertOk(res: YeastarResponse): void {
    if (res.errcode !== 0) throw new YeastarError(res.errcode, res.errmsg);
  }
}

export class YeastarError extends Error {
  constructor(public readonly code: number, public readonly yeastarMessage: string) {
    super(`Yeastar error ${code}: ${yeastarMessage}`);
    this.name = "YeastarError";
  }
}
