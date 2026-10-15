/**
 * Gera os prompts de voz do OTP e grava-os na pasta de sons do Asterisk
 * (ASTERISK_SOUNDS_DIR), onde o motor os toca como sound:custom/<nome>.
 *
 * Não usa TTS pago: a voz é gerada localmente com o `say` do macOS e convertida
 * para WAV PCM 8kHz mono 16-bit com `afconvert`. Só corre em macOS: para o
 * servidor, gerar aqui e copiar os otp_*.wav para a pasta de sons de lá.
 *
 * Os prompts são fixos (intro, dígitos 0-9, "repito", "obrigado"), gerados uma
 * única vez. O OtpCallService monta a sequência para cada código em runtime.
 *
 * Uso:  pnpm -F api otp:prompts
 *       (ou)  npx tsx apps/api/scripts/setup-otp-prompts.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsteriskAdapter } from "@falai/providers";

// name (sem extensão) → { text, voice }. Prefixo por idioma.
const DIGITS_PT: Record<string, string> = {
  "0": "zero", "1": "um", "2": "dois", "3": "três", "4": "quatro",
  "5": "cinco", "6": "seis", "7": "sete", "8": "oito", "9": "nove",
};
const DIGITS_EN: Record<string, string> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
};

interface PromptSpec {
  name: string; // nome do ficheiro (sem extensão) na pasta de sons
  text: string;
  voice: string;
}

const PAUSE = "[[slnc 450]]"; // silêncio após cada dígito para separação clara
const RATE = 140; // palavras/min (default do `say` é ~175 — mais lento = mais claro)

function buildPromptList(): PromptSpec[] {
  const list: PromptSpec[] = [];

  // Português (Joana, pt_PT)
  list.push({ name: "otp_pt_intro", text: "O seu código de verificação é", voice: "Joana" });
  list.push({ name: "otp_pt_repito", text: "Repito", voice: "Joana" });
  list.push({ name: "otp_pt_obrigado", text: "Obrigado", voice: "Joana" });
  for (const [d, word] of Object.entries(DIGITS_PT)) {
    list.push({ name: `otp_pt_d${d}`, text: `${word} ${PAUSE}`, voice: "Joana" });
  }

  // Inglês (Samantha, en_US)
  list.push({ name: "otp_en_intro", text: "Your verification code is", voice: "Samantha" });
  list.push({ name: "otp_en_repito", text: "I repeat", voice: "Samantha" });
  list.push({ name: "otp_en_obrigado", text: "Thank you", voice: "Samantha" });
  for (const [d, word] of Object.entries(DIGITS_EN)) {
    list.push({ name: `otp_en_d${d}`, text: `${word} ${PAUSE}`, voice: "Samantha" });
  }

  return list;
}

function synthesizeWav(spec: PromptSpec, workDir: string): Buffer {
  const aiff = join(workDir, `${spec.name}.aiff`);
  const wav = join(workDir, `${spec.name}.wav`);
  execFileSync("say", ["-v", spec.voice, "-r", String(RATE), "-o", aiff, spec.text]);
  // WAV PCM 16-bit little-endian, 8000 Hz, mono — o ".wav" de 8 kHz do Asterisk
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@8000", "-c", "1", aiff, wav]);
  return readFileSync(wav);
}

async function main() {
  const soundsDir = process.env["ASTERISK_SOUNDS_DIR"];
  if (!soundsDir) {
    console.error("ASTERISK_SOUNDS_DIR em falta — é a pasta de sons partilhada com o Asterisk.");
    process.exit(1);
  }
  // Só o uploadPrompt é usado: escreve no disco, não fala com o ARI.
  const adapter = new AsteriskAdapter({ baseUrl: "", username: "", password: "", soundsDir });

  const workDir = mkdtempSync(join(tmpdir(), "otp-prompts-"));
  const prompts = buildPromptList();

  console.info(`A gerar ${prompts.length} prompts em ${soundsDir}…`);
  let ok = 0;
  for (const spec of prompts) {
    try {
      const wav = synthesizeWav(spec, workDir);
      await adapter.uploadPrompt(spec.name, wav);
      ok++;
      console.info(`  ✓ ${spec.name} (${wav.length} bytes)`);
    } catch (err) {
      console.error(`  ✗ ${spec.name}:`, err instanceof Error ? err.message : err);
    }
  }

  rmSync(workDir, { recursive: true, force: true });
  console.info(`\nConcluído: ${ok}/${prompts.length} prompts gravados.`);
  process.exit(ok === prompts.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
