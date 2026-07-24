import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TtsProvider } from "./TtsProvider.js";

const exec = promisify(execFile);

/**
 * Adaptador TTS local usando `say` (macOS) + `afconvert`.
 * Não requer nenhuma API externa — útil para desenvolvimento e testes.
 * Em produção (Linux) usa-se ElevenLabs ou outro provedor cloud.
 *
 * voiceId mapeia para vozes do `say -v`: "Joana" (PT), "Samantha" (EN), etc.
 * Se voiceId for desconhecido, usa a voz do sistema por defeito.
 */
export class MacOsTtsAdapter implements TtsProvider {
  constructor(private readonly defaultVoice = "Joana") {}

  async synthesize(params: {
    text: string;
    voiceId: string;
    language?: string;
  }): Promise<{ wavBuffer: Buffer; durationMs: number; characters: number }> {
    const voice = params.voiceId || this.defaultVoice;
    const dir = await mkdtemp(join(tmpdir(), "falai-tts-"));
    const aiffPath = join(dir, "out.aiff");
    const wavPath = join(dir, "out.wav");

    try {
      // Gera AIFF com o say do macOS
      await exec("say", ["-v", voice, "-o", aiffPath, "--", params.text]);

      // Converte para WAV PCM 16-bit 8 kHz mono (formato aceite pelo Yeastar)
      await exec("afconvert", [aiffPath, "-o", wavPath, "-d", "LEI16@8000", "-c", "1"]);

      const wavBuffer = await readFile(wavPath);
      const durationMs = Math.round((wavBuffer.length / (8000 * 2)) * 1000);

      return { wavBuffer, durationMs, characters: params.text.length };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    try {
      await exec("which", ["say"]);
      await exec("which", ["afconvert"]);
      return { ok: true, details: "macOS say + afconvert disponíveis" };
    } catch {
      return { ok: false, details: "say ou afconvert não encontrados (requer macOS)" };
    }
  }
}
