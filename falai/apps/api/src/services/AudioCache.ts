import type { Redis } from "ioredis";
import type { TtsProvider } from "@falai/providers";
import type { TelephonyProvider } from "@falai/providers";

const CACHE_PREFIX = "falai:audio_cache:";

// Common prompts to pre-generate and upload to Yeastar at startup
const COMMON_PROMPTS: Array<{ name: string; text: string }> = [
  { name: "greeting_ptao", text: "Olá! Bom dia. A falar é um assistente virtual da Falaí." },
  { name: "farewell_ptao", text: "Obrigado pelo contacto. Tenha um excelente dia. Até logo!" },
  { name: "wait_ptao", text: "Um momento, por favor." },
  { name: "notunderstood_ptao", text: "Desculpe, não percebi. Pode repetir, por favor?" },
  { name: "optout_ptao", text: "Compreendo. Registo o seu pedido e não voltaremos a contactá-lo. Tenha um bom dia." },
  { name: "silence_dtmf", text: "Para confirmar, prima 1. Para repetir, prima 2. Para falar com um atendente, prima 9." },
];

export class AudioCache {
  private redis: Redis;
  private tts: TtsProvider;
  private telephony: TelephonyProvider;
  private defaultVoiceId: string;

  constructor(redis: Redis, tts: TtsProvider, telephony: TelephonyProvider, defaultVoiceId: string) {
    this.redis = redis;
    this.tts = tts;
    this.telephony = telephony;
    this.defaultVoiceId = defaultVoiceId;
  }

  /**
   * Initialise common audio prompts. Skips if already cached in Redis.
   * Called once at API startup.
   */
  async warmUp(): Promise<void> {
    for (const prompt of COMMON_PROMPTS) {
      const key = `${CACHE_PREFIX}${prompt.name}`;
      const exists = await this.redis.exists(key);
      if (!exists) {
        try {
          const { wavBuffer } = await this.tts.synthesize({
            text: prompt.text,
            voiceId: this.defaultVoiceId,
          });
          await this.telephony.uploadPrompt(prompt.name, wavBuffer);
          await this.redis.set(key, "1"); // mark as uploaded
          console.info(`[AudioCache] warmed: ${prompt.name}`);
        } catch (err) {
          console.warn(`[AudioCache] failed to warm ${prompt.name}:`, err);
        }
      }
    }
  }

  /** Returns the Yeastar prompt name for a given key (no-extension, ready for play_prompt). */
  getPromptName(key: "greeting" | "farewell" | "wait" | "not_understood" | "optout" | "dtmf_menu"): string {
    const map: Record<string, string> = {
      greeting: "greeting_ptao",
      farewell: "farewell_ptao",
      wait: "wait_ptao",
      not_understood: "notunderstood_ptao",
      optout: "optout_ptao",
      dtmf_menu: "silence_dtmf",
    };
    return map[key] ?? key;
  }

  /** Generate, upload, and return name for a dynamic response (agent turn reply). */
  async prepareDynamic(text: string, voiceId: string, callId: string, seq: number): Promise<string> {
    const name = `dyn_${callId}_${seq}`.slice(0, 32); // Yeastar name length limit
    const cacheKey = `${CACHE_PREFIX}dynamic:${name}`;

    const exists = await this.redis.exists(cacheKey);
    if (!exists) {
      const { wavBuffer } = await this.tts.synthesize({ text, voiceId });
      await this.telephony.uploadPrompt(name, wavBuffer);
      await this.redis.set(cacheKey, "1", "EX", 3600); // 1h TTL for dynamic
    }

    return name;
  }
}
