import type { Redis } from "ioredis";
import type { TtsProvider } from "@falai/providers";

const CACHE_KEY = "tts:voices";
const CACHE_TTL_SECONDS = 300;

/**
 * Valida um ttsVoiceId contra a lista real do provedor de TTS.
 *
 * Sem isto, qualquer string era aceite e só rebentava minutos depois, no
 * dispatcher: a campanha arrancava, falhava a gerar o áudio e auto-pausava com
 * um erro que o cliente nunca via. Foi o que aconteceu com o placeholder
 * "pt-AO-female-1" copiado do seed de demonstração.
 *
 * A lista é cacheada no Redis (5 min) para não pagar uma chamada à API do
 * provedor em cada criação/edição de campanha.
 */
export class TtsVoiceValidator {
  constructor(
    private readonly redis: Redis,
    private readonly tts: TtsProvider
  ) {}

  /** `null` quando o provedor não sabe listar vozes — nesse caso não se valida. */
  async listVoices(): Promise<Array<{ voiceId: string; name: string }> | null> {
    const cached = await this.redis.get(CACHE_KEY).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as Array<{ voiceId: string; name: string }>;
      } catch {
        // cache corrompida — segue para o provedor
      }
    }

    const voices = await this.tts.listVoices();
    if (voices === null) return null;

    await this.redis.set(CACHE_KEY, JSON.stringify(voices), "EX", CACHE_TTL_SECONDS).catch(() => undefined);
    return voices;
  }

  /**
   * Deixa passar (fail-open) quando a lista não está disponível: uma falha de
   * rede na ElevenLabs não deve impedir alguém de criar uma campanha.
   * Só rejeita quando a lista veio e o id não está lá.
   */
  async assertKnownVoice(voiceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const voices = await this.listVoices();
    if (voices === null) return { ok: true };
    if (voices.some((v) => v.voiceId === voiceId)) return { ok: true };

    const sample = voices.slice(0, 5).map((v) => `${v.name} (${v.voiceId})`).join(", ");
    return {
      ok: false,
      error:
        `Voz TTS desconhecida: "${voiceId}". Use um ID de voz válido do provedor` +
        (sample ? `. Vozes disponíveis incluem: ${sample}` : "."),
    };
  }
}
