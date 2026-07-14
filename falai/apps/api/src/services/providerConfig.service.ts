import { config } from "../config.js";
import { getSetting } from "./settings.service.js";

/**
 * Resolve a configuração dos provedores externos.
 *
 * Ordem de precedência: SystemSetting (editável no backoffice, segredos
 * encriptados) → variável de ambiente (.env) → default. As chaves em
 * SystemSetting usam os mesmos nomes das variáveis de ambiente.
 *
 * Nota: os valores são lidos uma vez no arranque, portanto alterações no
 * backoffice só passam a valer após reiniciar a API.
 */

export interface ResolvedProviderConfig {
  yeastar: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    stubMode: boolean;
    outboundExtension: string;
  };
  deepgram: { apiKey: string };
  anthropic: { apiKey: string };
  elevenlabs: { apiKey: string; defaultVoiceId: string };
  proxypay: { apiKey: string };
  futurix: { apiKey: string };
}

/** Chaves de provedores geridas via SystemSetting (para o backoffice conhecer o conjunto). */
export const PROVIDER_SETTING_KEYS = [
  "YEASTAR_BASE_URL",
  "YEASTAR_CLIENT_ID",
  "YEASTAR_CLIENT_SECRET",
  "YEASTAR_STUB_MODE",
  "YEASTAR_OUTBOUND_EXTENSION",
  "DEEPGRAM_API_KEY",
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_DEFAULT_VOICE_ID",
  "PROXYPAY_API_KEY",
  "FUTURIX_SMS_API_KEY",
] as const;

async function val(key: string, envFallback: string | undefined): Promise<string | undefined> {
  const stored = await getSetting(key);
  if (stored !== null && stored.trim() !== "") return stored;
  return envFallback;
}

export async function resolveProviderConfig(): Promise<ResolvedProviderConfig> {
  const [yBase, yId, ySecret, yStub, yExt, dg, an, el, elVoice, pp, fx] = await Promise.all([
    val("YEASTAR_BASE_URL", config.YEASTAR_BASE_URL),
    val("YEASTAR_CLIENT_ID", config.YEASTAR_CLIENT_ID),
    val("YEASTAR_CLIENT_SECRET", config.YEASTAR_CLIENT_SECRET),
    val("YEASTAR_STUB_MODE", config.YEASTAR_STUB_MODE ? "true" : "false"),
    val("YEASTAR_OUTBOUND_EXTENSION", config.YEASTAR_OUTBOUND_EXTENSION),
    val("DEEPGRAM_API_KEY", config.DEEPGRAM_API_KEY),
    val("ANTHROPIC_API_KEY", config.ANTHROPIC_API_KEY),
    val("ELEVENLABS_API_KEY", config.ELEVENLABS_API_KEY),
    val("ELEVENLABS_DEFAULT_VOICE_ID", process.env["ELEVENLABS_DEFAULT_VOICE_ID"]),
    val("PROXYPAY_API_KEY", config.PROXYPAY_API_KEY),
    val("FUTURIX_SMS_API_KEY", config.FUTURIX_SMS_API_KEY),
  ]);

  return {
    yeastar: {
      baseUrl: yBase ?? "http://localhost:8080",
      clientId: yId ?? "",
      clientSecret: ySecret ?? "",
      stubMode: yStub === "true",
      outboundExtension: yExt ?? "1000",
    },
    deepgram: { apiKey: dg ?? "" },
    anthropic: { apiKey: an ?? "" },
    elevenlabs: { apiKey: el ?? "", defaultVoiceId: elVoice ?? "21m00Tcm4TlvDq8ikWAM" },
    proxypay: { apiKey: pp ?? "" },
    futurix: { apiKey: fx ?? "" },
  };
}
