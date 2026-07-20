import type { FastifyBaseLogger } from "fastify";
import type { YeastarAdapter } from "@falai/providers";

export interface OtpCallParams {
  to: string;
  code: string;
  fromExtension: string;
  dialPermission?: string;
  language?: string;
  autoAnswer?: "yes" | "no";
  telephony: YeastarAdapter;
}

/**
 * Entrega de código OTP por voz.
 *
 * Usa o `call/play_prompt` do Yeastar, que faz a chamada de saída ao destino e toca
 * a sequência de prompts pré-gravados (intro + dígitos + "repito" + dígitos + fecho).
 * O Yeastar trata do ciclo completo — dial, atender, tocar, desligar — pelo que não
 * é preciso polling nem eventos.
 *
 * Os prompts têm de ter sido enviados previamente com `pnpm -F api otp:prompts`.
 */
export class OtpCallService {
  constructor(private log: FastifyBaseLogger) {}

  async initiateCall(params: OtpCallParams): Promise<{ providerCallId: string }> {
    const prompts = buildPromptSequence(params.code, params.language ?? "pt");
    const ref = `otp_${Date.now()}`;

    await params.telephony.playPrompt({
      number: params.to,
      prompts,
      count: 1,
      dialPermission: params.dialPermission ?? params.fromExtension,
      autoAnswer: params.autoAnswer ?? "no",
    });

    this.log.info({ ref, to: params.to, prompts: prompts.length }, "otp_call.initiated");
    return { providerCallId: ref };
  }
}

/**
 * Monta a lista de prompts pré-gravados para um código.
 * Ex.: código "847" em PT →
 *   [otp_pt_intro, otp_pt_d8, otp_pt_d4, otp_pt_d7,
 *    otp_pt_repito, otp_pt_d8, otp_pt_d4, otp_pt_d7, otp_pt_obrigado]
 */
function buildPromptSequence(code: string, language: string): string[] {
  const lang = language.startsWith("pt") ? "pt" : "en";
  const p = (suffix: string) => `otp_${lang}_${suffix}`;
  const digitPrompts = code
    .split("")
    .filter((c) => /\d/.test(c))
    .map((d) => p(`d${d}`));

  return [p("intro"), ...digitPrompts, p("repito"), ...digitPrompts, p("obrigado")];
}
