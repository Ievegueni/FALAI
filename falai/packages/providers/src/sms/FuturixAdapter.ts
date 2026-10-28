import axios, { type AxiosInstance } from "axios";
import type { SmsProvider, SendSmsParams, SendSmsResult } from "./SmsProvider.js";

export interface FuturixConfig {
  baseUrl: string;
  apiKey: string;
  defaultSenderId?: string;
  stubMode?: boolean;
}

// Resposta de POST /api/v1/sms/send
interface FuturixSendResponse {
  success?: boolean;
  message?: string;
  data?: {
    message_id?: string;
    status?: string;
    destination?: string;
    parts?: number;
    encoding?: string;
    created_at?: string;
  };
}

/**
 * Adaptador do gateway de SMS Futurix (https://sms-api.futurix.ao).
 * As credenciais (apiKey/senderId) são por cliente — instanciado por tenant em
 * `getTenantSms`. Em stubMode não faz chamadas de rede (dev/testes).
 *
 * Envio:  POST /api/v1/sms/send  { sender_id, destination, message, campaign_id? }
 *         → 202 { success, data: { message_id, status, parts, encoding, ... } }
 */
export class FuturixAdapter implements SmsProvider {
  private http: AxiosInstance;
  private config: FuturixConfig;

  private static readonly PATH_SEND = "/api/v1/sms/send";
  private static readonly PATH_BULK = "/api/v1/sms/bulk";

  constructor(config: FuturixConfig) {
    this.config = config;
    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ""),
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  async send(params: SendSmsParams): Promise<SendSmsResult> {
    const senderId = params.senderId ?? this.config.defaultSenderId;
    // A Futurix espera o destino com indicativo e sem "+".
    // Números nacionais (9xxxxxxxx) e "00244…" passam a 244…: sem indicativo a
    // Futurix recusava (422) ou encaminhava mal.
    let destination = params.to.replace(/[^\d]/g, "").replace(/^00/, "");
    if (/^9\d{8}$/.test(destination)) destination = `244${destination}`;

    if (this.config.stubMode) {
      const id = `stub_sms_${Date.now()}`;
      console.info(`[FuturixAdapter STUB] send → to=${destination} sender=${senderId ?? "-"} id=${id}`);
      return { providerMsgId: id, accepted: true, details: "stub mode" };
    }

    try {
      const res = await this.http.post<FuturixSendResponse>(FuturixAdapter.PATH_SEND, {
        ...(senderId ? { sender_id: senderId } : {}),
        destination,
        message: params.body,
      });
      const providerMsgId = res.data?.data?.message_id ?? null;
      return { providerMsgId, accepted: res.data?.success !== false };
    } catch (err) {
      if (!axios.isAxiosError(err)) return { providerMsgId: null, accepted: false, details: String(err) };
      const status = err.response?.status;
      const raw = JSON.stringify(err.response?.data ?? err.message);
      return {
        providerMsgId: null,
        accepted: false,
        details: futurixFailReason(status, raw),
        // Sem resposta = timeout/rede; 429 e 5xx são do lado deles e passam.
        retryable: status === undefined || status === 429 || status >= 500,
      };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.config.stubMode) return { ok: true, details: "stub mode" };
    if (!this.config.apiKey) return { ok: false, details: "sem API key" };
    return { ok: true };
  }
}

/** Motivo legível para o cliente a partir do código HTTP da Futurix. */
export function futurixFailReason(status: number | undefined, raw: string): string {
  switch (status) {
    case undefined: return `Sem resposta da Futurix (timeout/rede): ${raw}`;
    case 401: return "Futurix recusou as credenciais (401) — verificar a API key SMS do cliente";
    case 402: return "Conta Futurix sem saldo (402) — carregar a conta junto da Futurix";
    case 422: return `Futurix recusou a mensagem (422) — número ou remetente inválido: ${raw}`;
    case 429: return "Futurix: demasiados pedidos (429)";
    default: return `Futurix HTTP ${status}: ${raw}`;
  }
}
