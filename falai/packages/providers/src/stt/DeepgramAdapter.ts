import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { SttProvider } from "./SttProvider.js";

export interface DeepgramConfig {
  apiKey: string;
  model?: string;    // default "nova-2"
  language?: string; // default "pt"
  stubMode?: boolean;
}

export class DeepgramAdapter implements SttProvider {
  private config: DeepgramConfig;

  constructor(config: DeepgramConfig) {
    this.config = config;
  }

  async streamingTranscribe(params: {
    sampleRate: number;
    language?: string;
    onPartial: (text: string) => void;
    onFinal: (text: string, durationMs: number) => void;
    onError: (err: Error) => void;
  }): Promise<{ sendAudio: (frame: Buffer) => void; finish: () => Promise<void> }> {
    if (this.config.stubMode) {
      return this.stubTranscribe(params);
    }

    const client = createClient(this.config.apiKey);
    const startedAt = Date.now();

    const connection = client.listen.live({
      model: this.config.model ?? "nova-2",
      language: params.language ?? this.config.language ?? "pt",
      smart_format: true,
      encoding: "linear16",
      sample_rate: params.sampleRate,
      channels: 1,
      interim_results: true,
      endpointing: 300, // ms of silence before final
    });

    let resolveOpen: () => void;
    const openPromise = new Promise<void>((r) => { resolveOpen = r; });

    connection.on(LiveTranscriptionEvents.Open, () => resolveOpen());
    connection.on(LiveTranscriptionEvents.Error, (err: Error) => params.onError(err));

    connection.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
      const d = data as {
        channel?: { alternatives?: Array<{ transcript?: string }> };
        is_final?: boolean;
        speech_final?: boolean;
      };
      const transcript = d?.channel?.alternatives?.[0]?.transcript ?? "";
      if (!transcript) return;
      if (d.speech_final) {
        params.onFinal(transcript, Date.now() - startedAt);
      } else if (!d.is_final) {
        params.onPartial(transcript);
      }
    });

    await openPromise;

    return {
      sendAudio: (frame: Buffer) => {
        // Deepgram SDK expects ArrayBuffer or Blob — convert Buffer
        connection.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
      },
      finish: () => new Promise<void>((resolve) => {
        connection.requestClose();
        connection.on(LiveTranscriptionEvents.Close, () => resolve());
        // Fallback timeout
        setTimeout(resolve, 3000);
      }),
    };
  }

  private stubTranscribe(params: {
    onPartial: (text: string) => void;
    onFinal: (text: string, durationMs: number) => void;
    onError: (err: Error) => void;
  }): { sendAudio: (frame: Buffer) => void; finish: () => Promise<void> } {
    let frameCount = 0;
    let fired = false;
    const startedAt = Date.now();

    // After ~2s of audio (at 16kHz, 2 bytes/sample → ~64000 bytes), return stub transcript
    const FRAMES_THRESHOLD = 20;

    const checkAndFire = () => {
      if (!fired && frameCount >= FRAMES_THRESHOLD) {
        fired = true;
        const stubbedPhrases = [
          "Olá, preciso de ajuda com a minha conta.",
          "Quando é que posso fazer o pagamento?",
          "Pode repetir o valor em dívida?",
          "Sim, concordo com o pagamento.",
        ];
        const phrase = stubbedPhrases[frameCount % stubbedPhrases.length] ?? stubbedPhrases[0]!;
        params.onPartial(phrase);
        setTimeout(() => params.onFinal(phrase!, Date.now() - startedAt), 300);
      }
    };

    return {
      sendAudio: () => {
        frameCount++;
        checkAndFire();
      },
      finish: () => {
        if (!fired) {
          fired = true;
          params.onFinal("Obrigado, até logo.", Date.now() - startedAt);
        }
        return Promise.resolve();
      },
    };
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.config.stubMode) return { ok: true, details: "stub mode" };
    try {
      const client = createClient(this.config.apiKey);
      // Simple balance check to verify auth
      const response = await client.manage.getProjects();
      return { ok: !!response, details: "connected" };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }
}
