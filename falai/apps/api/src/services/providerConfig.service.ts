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
 * backoffice só passam a valer após reiniciar a API (botão "Reiniciar API"
 * em Configurações → routes/admin/system.ts).
 */

export interface ResolvedProviderConfig {
  deepgram: { apiKey: string };
  anthropic: { apiKey: string };
  elevenlabs: { apiKey: string; defaultVoiceId: string };
  proxypay: { apiKey: string };
  futurix: { apiKey: string; baseUrl: string; stubMode: boolean };
  /** IA em modo de teste (STT/LLM/TTS sem chamar os provedores). Backoffice → .env AI_STUB_MODE. */
  aiStubMode: boolean;
}

/** Chaves de provedores geridas via SystemSetting (para o backoffice conhecer o conjunto). */
export const PROVIDER_SETTING_KEYS = [
  "DEEPGRAM_API_KEY",
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_DEFAULT_VOICE_ID",
  "PROXYPAY_API_KEY",
  "FUTURIX_SMS_API_KEY",
  "FUTURIX_SMS_BASE_URL",
  "FUTURIX_SMS_STUB_MODE",
  "AI_STUB_MODE",
] as const;

async function val(key: string, envFallback: string | undefined): Promise<string | undefined> {
  const stored = await getSetting(key);
  if (stored !== null && stored.trim() !== "") return stored;
  return envFallback;
}

export async function resolveProviderConfig(): Promise<ResolvedProviderConfig> {
  const [dg, an, el, elVoice, pp, fx, fxBase, fxStub, aiStub] = await Promise.all([
    val("DEEPGRAM_API_KEY", config.DEEPGRAM_API_KEY),
    val("ANTHROPIC_API_KEY", config.ANTHROPIC_API_KEY),
    val("ELEVENLABS_API_KEY", config.ELEVENLABS_API_KEY),
    val("ELEVENLABS_DEFAULT_VOICE_ID", process.env["ELEVENLABS_DEFAULT_VOICE_ID"]),
    val("PROXYPAY_API_KEY", config.PROXYPAY_API_KEY),
    val("FUTURIX_SMS_API_KEY", config.FUTURIX_SMS_API_KEY),
    val("FUTURIX_SMS_BASE_URL", config.FUTURIX_SMS_BASE_URL),
    val("FUTURIX_SMS_STUB_MODE", config.FUTURIX_SMS_STUB_MODE ? "true" : "false"),
    val("AI_STUB_MODE", config.AI_STUB_MODE ? "true" : "false"),
  ]);

  return {
    deepgram: { apiKey: dg ?? "" },
    anthropic: { apiKey: an ?? "" },
    elevenlabs: { apiKey: el ?? "", defaultVoiceId: elVoice ?? "21m00Tcm4TlvDq8ikWAM" },
    proxypay: { apiKey: pp ?? "" },
    futurix: {
      apiKey: fx ?? "",
      baseUrl: fxBase ?? "https://sms-api.futurix.ao",
      stubMode: fxStub === "true",
    },
    aiStubMode: aiStub === "true",
  };
}
