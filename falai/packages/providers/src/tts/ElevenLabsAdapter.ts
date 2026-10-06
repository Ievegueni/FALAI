import type { TtsProvider } from "./TtsProvider.js";

export interface ElevenLabsConfig {
  apiKey: string;
  modelId?: string;     // default "eleven_multilingual_v2"
  outputFormat?: string; // default "pcm_16000"
  stubMode?: boolean;
}

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

export class ElevenLabsAdapter implements TtsProvider {
  private config: ElevenLabsConfig;

  constructor(config: ElevenLabsConfig) {
    this.config = config;
  }

  async synthesize(params: {
    text: string;
    voiceId: string;
    language?: string;
  }): Promise<{ wavBuffer: Buffer; durationMs: number; characters: number }> {
    if (this.config.stubMode) {
      return { wavBuffer: silentWav(500), durationMs: 50, characters: params.text.length };
    }

    const startedAt = Date.now();
    const outputFormat = this.config.outputFormat ?? "pcm_16000";

    const res = await fetch(
      `${ELEVENLABS_BASE}/text-to-speech/${params.voiceId}?output_format=${outputFormat}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: params.text,
          model_id: this.config.modelId ?? "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${msg}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const pcmBuffer = Buffer.from(arrayBuffer);

    // Wrap PCM in WAV container (ElevenLabs pcm_16000 = 16kHz, 16-bit, mono)
    const wavBuffer = outputFormat.startsWith("pcm_")
      ? pcmToWav(pcmBuffer, 16000, 1, 16)
      : pcmBuffer; // mp3/other — upload as-is

    return {
      wavBuffer,
      durationMs: Date.now() - startedAt,
      characters: params.text.length,
    };
  }

  async listVoices(): Promise<Array<{ voiceId: string; name: string }> | null> {
    if (this.config.stubMode) return null;
    try {
      const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
        headers: { "xi-api-key": this.config.apiKey },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { voices?: Array<{ voice_id?: string; name?: string }> };
      if (!Array.isArray(body.voices)) return null;
      return body.voices
        .filter((v): v is { voice_id: string; name?: string } => typeof v.voice_id === "string")
        .map((v) => ({ voiceId: v.voice_id, name: v.name ?? v.voice_id }));
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.config.stubMode) return { ok: true, details: "stub mode" };
    try {
      const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
        headers: { "xi-api-key": this.config.apiKey },
      });
      return { ok: res.ok, details: res.ok ? "connected" : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }
}

// Build a minimal WAV header around raw PCM data
function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitDepth) / 8, 28);
  header.writeUInt16LE((channels * bitDepth) / 8, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Returns a minimal valid silent WAV for stub/cache use
export function silentWav(durationMs: number): Buffer {
  const sampleRate = 16000;
  const samples = Math.ceil((sampleRate * durationMs) / 1000);
  const pcm = Buffer.alloc(samples * 2, 0); // 16-bit silence
  return pcmToWav(pcm, sampleRate, 1, 16);
}
