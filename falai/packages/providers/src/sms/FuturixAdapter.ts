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
    const destination = params.to.replace(/[^\d]/g, "");

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
      const details = axios.isAxiosError(err)
        ? `${err.response?.status ?? ""} ${JSON.stringify(err.response?.data ?? err.message)}`
        : String(err);
      return { providerMsgId: null, accepted: false, details };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.config.stubMode) return { ok: true, details: "stub mode" };
    if (!this.config.apiKey) return { ok: false, details: "sem API key" };
    return { ok: true };
  }
}
