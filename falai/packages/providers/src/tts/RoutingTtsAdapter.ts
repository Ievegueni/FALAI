import type { TtsProvider } from "./TtsProvider.js";

/** Prefixo das vozes que vão para a ElevenLabs quando o provedor principal é local. */
export const ELEVENLABS_VOICE_PREFIX = "elevenlabs:";

/**
 * Junta o provedor principal (ex.: Piper) com a ElevenLabs.
 *
 * Só vão para a ElevenLabs as vozes escritas com o prefixo explícito
 * `elevenlabs:<voiceId>` (ex.: a voz de um grupo de linhas do cliente). Tudo o
 * resto segue para o principal exactamente como antes: a FÁCIL CREDITO manda
 * um `ttsVoiceId` ElevenLabs em todas as campanhas e o Piper ignora-o; escolher
 * o provedor pela forma do id mudaria a voz da cobrança sem ninguém pedir.
 *
 * Se a ElevenLabs falhar (chave, fatura, limite), sintetiza com o principal e
 * a voz por omissão dele, e marca `fallback: true` para quem guarda o áudio
 * em cache poder tentar outra vez mais tarde.
 */
export class RoutingTtsAdapter implements TtsProvider {
  constructor(
    private readonly primary: TtsProvider,
    private readonly primaryDefaultVoice: string,
    private readonly elevenlabs: TtsProvider | null,
    private readonly onFallback?: (info: { voiceId: string; error: string }) => void,
  ) {}

  async synthesize(params: { text: string; voiceId: string; language?: string }) {
    if (!params.voiceId.startsWith(ELEVENLABS_VOICE_PREFIX)) {
      return this.primary.synthesize(params);
    }
    const voiceId = params.voiceId.slice(ELEVENLABS_VOICE_PREFIX.length);
    try {
      if (!this.elevenlabs || !voiceId) throw new Error("ElevenLabs não configurada");
      return await this.elevenlabs.synthesize({ ...params, voiceId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.onFallback?.({ voiceId: params.voiceId, error });
      // Se o principal for a própria ElevenLabs (sandbox), o recurso é a voz por omissão dela.
      const out = await this.primary.synthesize({ ...params, voiceId: this.primaryDefaultVoice });
      return { ...out, fallback: true };
    }
  }

  listVoices() {
    return this.primary.listVoices();
  }

  healthCheck() {
    return this.primary.healthCheck();
  }
}
