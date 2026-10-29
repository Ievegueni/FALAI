import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TtsProvider } from "./TtsProvider.js";

const exec = promisify(execFile);

/**
 * Adaptador TTS local usando Piper (voz PT-PT "tugão") + ffmpeg.
 * Corre em Linux sem GPU nem API externa. Ver docs/PIPER-TTS.md.
 *
 * Só há um modelo carregado (PIPER_MODEL), por isso voiceId é ignorado.
 */
export class PiperTtsAdapter implements TtsProvider {
  constructor(
    private readonly piperBin: string,
    private readonly modelPath: string,
  ) {}

  async synthesize(params: {
    text: string;
    voiceId: string;
    language?: string;
  }): Promise<{ wavBuffer: Buffer; durationMs: number; characters: number }> {
    const dir = await mkdtemp(join(tmpdir(), "falai-tts-"));
    const rawPath = join(dir, "raw.wav");
    const wavPath = join(dir, "out.wav");

    try {
      // Piper lê o texto do stdin
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.piperBin, ["-m", this.modelPath, "-f", rawPath]);
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`piper saiu com ${code}: ${err.slice(-500)}`))));
        p.stdin.end(params.text);
      });

      // Converte para WAV PCM 16-bit 8 kHz mono (formato de telefonia)
      await exec("ffmpeg", ["-y", "-loglevel", "error", "-i", rawPath, "-ar", "8000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);

      const wavBuffer = await readFile(wavPath);
      const durationMs = Math.round((wavBuffer.length / (8000 * 2)) * 1000);

      return { wavBuffer, durationMs, characters: params.text.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async listVoices(): Promise<Array<{ voiceId: string; name: string }> | null> {
    return null;
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      await exec(this.piperBin, ["--help"]);
      await exec("ffmpeg", ["-version"]);
      await readFile(this.modelPath + ".json");
      return { ok: true, details: `piper + ffmpeg disponíveis, modelo ${this.modelPath}` };
    } catch (e) {
      return { ok: false, details: `piper/ffmpeg/modelo em falta: ${(e as Error).message}` };
    }
  }
}
