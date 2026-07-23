import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TtsProvider } from "./TtsProvider.js";

const execFileAsync = promisify(execFile);

/**
 * TTS local via `say` + `afconvert` do macOS — usado apenas em dev quando
 * TTS_PROVIDER=macos (sem chave de API externa). Não disponível em Linux.
 */
export class MacOsTtsAdapter implements TtsProvider {
  constructor(private voice: string = "Joana") {}

  async synthesize(params: {
    text: string;
    voiceId: string;
    language?: string;
  }): Promise<{ wavBuffer: Buffer; durationMs: number; characters: number }> {
    const startedAt = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "falai-tts-"));
    const aiffPath = join(dir, "out.aiff");
    const wavPath = join(dir, "out.wav");

    try {
      await execFileAsync("say", ["-v", this.voice, "-o", aiffPath, params.text]);
      await execFileAsync("afconvert", [
        aiffPath,
        wavPath,
        "-f", "WAVE",
        "-d", "LEI16@16000",
        "-c", "1",
      ]);
      const wavBuffer = await readFile(wavPath);

      return {
        wavBuffer,
        durationMs: Date.now() - startedAt,
        characters: params.text.length,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      await execFileAsync("say", ["-v", "?"]);
      return { ok: true, details: "macos say available" };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }
}
