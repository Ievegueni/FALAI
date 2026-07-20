/**
 * Gera e faz upload dos prompts de voz do OTP para o Yeastar.
 *
 * Não usa TTS pago: a voz é gerada localmente com o `say` do macOS e convertida
 * para WAV PCM 8kHz mono 16-bit (formato aceite pelo Yeastar) com `afconvert`.
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
import Redis from "ioredis";
import { YeastarAdapter } from "@falai/providers";
import { resolveProviderConfig } from "../src/services/providerConfig.service.js";
import { config } from "../src/config.js";

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
  name: string; // nome do prompt no Yeastar
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
  // WAV PCM 16-bit little-endian, 8000 Hz, mono — formato de prompt do Yeastar
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@8000", "-c", "1", aiff, wav]);
  return readFileSync(wav);
}

async function main() {
  const providers = await resolveProviderConfig();
  if (providers.yeastar.stubMode) {
    console.error("Yeastar está em STUB mode — configura credenciais reais antes de fazer upload.");
    process.exit(1);
  }

  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const adapter = new YeastarAdapter(
    {
      baseUrl: providers.yeastar.baseUrl,
      clientId: providers.yeastar.clientId,
      clientSecret: providers.yeastar.clientSecret,
      stubMode: false,
    },
    redis
  );

  const workDir = mkdtempSync(join(tmpdir(), "otp-prompts-"));
  const prompts = buildPromptList();

  console.info(`A gerar e enviar ${prompts.length} prompts para o Yeastar…`);
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
  await redis.quit();
  console.info(`\nConcluído: ${ok}/${prompts.length} prompts enviados.`);
  process.exit(ok === prompts.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
