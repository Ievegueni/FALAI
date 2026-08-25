import { prisma } from "@falai/db";
import type { SttProvider, LlmProvider, TtsProvider, TelephonyProvider, TurnMessage } from "@falai/providers";
import type { LlmTurnResponse } from "@falai/shared";
import type { AudioCache } from "./AudioCache.js";
import { applyGuardrails, recordViolation, FALLBACK_REPLY } from "./guardrail.service.js";

export interface TurnContext {
  callId: string;
  agentId: string;
  tenantId: string;
  toNumber: string;
  providerCallId: string;
  systemPrompt: string;
  ttsVoiceId: string;
  variables: Record<string, unknown>;
  history: TurnMessage[];
  seq: number;
  /**
   * Motor de IA deste turno. Ausente = o motor da plataforma injectado no
   * construtor. Preenchido quando o agente usa o modelo do próprio cliente
   * (produto API_BYOM) — ver services/modelResolver.service.ts.
   */
  llm?: LlmProvider;
  /** Id do TenantModel em uso, para ficar registado no turno. */
  modelId?: string | null;
  /** Números para onde este tenant pode transferir uma chamada. */
  allowedEscalationNumbers?: string[];
  maxReplyChars?: number;
}

export interface TurnResult {
  response: LlmTurnResponse;
  transcript: string;
  promptName: string;
  latencies: { sttMs: number; llmMs: number; ttsMs: number; playMs: number };
}

export class TurnProcessor {
  constructor(
    private stt: SttProvider,
    private llm: LlmProvider,
    private tts: TtsProvider,
    private telephony: TelephonyProvider,
    private audioCache: AudioCache
  ) {}

  /**
   * Process a single turn: audio buffer → STT → LLM → TTS → upload → play.
   * Returns timing metrics and the LLM response.
   */
  async processTurn(audioBuffer: Buffer | null, context: TurnContext): Promise<TurnResult> {
    // ── 1. STT ──────────────────────────────────────────────────────────────
    let transcript = "";
    let sttMs = 0;

    if (audioBuffer && audioBuffer.length > 0) {
      const sttStart = Date.now();
      transcript = await this.runStt(audioBuffer, context);
      sttMs = Date.now() - sttStart;
    } else {
      // No audio (e.g. first turn greeting) — empty transcript triggers agent greeting
      transcript = "";
    }

    // Record HUMAN turn
    if (transcript) {
      await prisma.callTurn.create({
        data: {
          callId: context.callId,
          seq: context.seq,
          role: "HUMAN",
          text: transcript,
          sttMs,
        },
      });
    }

    // ── 2. LLM ──────────────────────────────────────────────────────────────
    // O motor pode ser o nosso ou o do cliente (API_BYOM). Se for o dele e
    // falhar — timeout, HTTP, contrato — a chamada NÃO pode cair em silêncio:
    // fala-se a frase de recurso e segue-se.
    const llm = context.llm ?? this.llm;
    const llmStart = Date.now();
    let response: LlmTurnResponse;
    let llmMs = 0;
    let modelFailed = false;

    try {
      const result = await llm.generateTurnResponse({
        systemPrompt: context.systemPrompt,
        history: context.history,
        userText: transcript || "(início da chamada — cumprimentar o utilizador)",
        variables: context.variables,
      });
      response = result.response;
      llmMs = result.durationMs;
    } catch (err) {
      modelFailed = true;
      // Um timeout também custa tempo à chamada — registá-lo como zero
      // esconderia exactamente o problema que queremos ver nos relatórios.
      llmMs = Date.now() - llmStart;
      response = { reply: FALLBACK_REPLY, action: { type: "continue" } };
      await prisma.systemEvent
        .create({
          data: {
            severity: "ERROR",
            source: "turn-processor",
            tenantId: context.tenantId,
            message: `O modelo falhou a responder: ${err instanceof Error ? err.message : String(err)}`,
            payload: { callId: context.callId, agentId: context.agentId, modelId: context.modelId ?? null },
          },
        })
        .catch(() => {});
    }

    // ── 2b. Guardrails ───────────────────────────────────────────────────────
    // Última barreira antes de a resposta virar voz. Corre para os dois motores
    // — o prompt do cliente não a contorna porque não passa por lá.
    const guard = await applyGuardrails(
      { reply: response.reply, action: response.action },
      {
        tenantId: context.tenantId,
        callId: context.callId,
        allowedEscalationNumbers: context.allowedEscalationNumbers ?? [],
        ...(context.modelId !== undefined && { modelId: context.modelId }),
        ...(context.maxReplyChars !== undefined && { maxReplyChars: context.maxReplyChars }),
      }
    );

    if (guard.violated && !modelFailed) {
      // Fire-and-forget: contar violações não pode atrasar a chamada.
      void recordViolation({
        tenantId: context.tenantId,
        modelId: context.modelId ?? null,
        callId: context.callId,
        flags: guard.flags,
        originalReply: response.reply,
      }).catch(() => {});
    }

    response = { ...response, reply: guard.reply, action: guard.action as LlmTurnResponse["action"] };
    const agentText = guard.reply;

    // ── 3. TTS + upload ──────────────────────────────────────────────────────
    const ttsStart = Date.now();
    const promptName = await this.audioCache.prepareDynamic(agentText, context.ttsVoiceId, context.callId, context.seq);
    const ttsMs = Date.now() - ttsStart;

    // ── 4. play_prompt ───────────────────────────────────────────────────────
    const playStart = Date.now();
    await this.telephony.playPrompt({
      number: context.toNumber,
      prompts: [promptName],
      providerCallId: context.providerCallId,
    });
    const playMs = Date.now() - playStart; // time until play_prompt API call returns (not playback end)

    // ── Record AGENT turn with all latencies ─────────────────────────────────
    const agentSeq = transcript ? context.seq + 1 : context.seq;
    await prisma.callTurn.create({
      data: {
        callId: context.callId,
        seq: agentSeq,
        role: "AGENT",
        text: agentText,
        audioRef: promptName,
        sttMs: transcript ? sttMs : null,
        llmMs,
        ttsMs,
        playMs,
        modelId: context.modelId ?? null,
        // Só se grava quando houve violação — assim uma consulta por turnos
        // sinalizados é só "guardrailFlags is not null".
        ...(guard.violated && { guardrailFlags: guard.flags }),
      },
    });

    return {
      response,
      transcript,
      promptName,
      latencies: { sttMs, llmMs, ttsMs, playMs },
    };
  }

  /**
   * LLM-only turn for text simulators (no STT/TTS/telephony).
   *
   * `llm` permite simular contra o modelo do próprio cliente, mesmo antes de
   * este estar aprovado — é o sandbox dele. Os guardrails correm na mesma, para
   * ele ver ao que a resposta fica sujeita em produção.
   */
  async simulateTurn(params: {
    userText: string;
    systemPrompt: string;
    history: TurnMessage[];
    variables: Record<string, unknown>;
    llm?: LlmProvider;
    tenantId?: string;
    maxReplyChars?: number;
  }): Promise<{ reply: string; action: LlmTurnResponse["action"]; llmMs: number; guardrailFlags: string[] }> {
    const start = Date.now();
    const { response } = await (params.llm ?? this.llm).generateTurnResponse({
      systemPrompt: params.systemPrompt,
      history: params.history,
      userText: params.userText,
      variables: params.variables,
    });
    const llmMs = Date.now() - start;

    const guard = await applyGuardrails(
      { reply: response.reply, action: response.action },
      {
        tenantId: params.tenantId ?? "",
        callId: "simulate",
        // No simulador não há chamada para transferir, portanto qualquer
        // escalate é sinalizado — que é a informação útil para quem testa.
        allowedEscalationNumbers: [],
        ...(params.maxReplyChars !== undefined && { maxReplyChars: params.maxReplyChars }),
      }
    );

    return {
      reply: guard.reply,
      action: guard.action as LlmTurnResponse["action"],
      llmMs,
      guardrailFlags: guard.flags,
    };
  }

  /** Expose LLM for summary generation by CallEngineService */
  async runSttLlmForSummary(transcript: string): Promise<{
    response: import("@falai/shared").LlmTurnResponse;
  }> {
    const { response } = await this.llm.generateTurnResponse({
      systemPrompt: "Gera um resumo conciso (2-3 frases) desta conversa telefónica em português angolano. Inclui o resultado e os próximos passos.",
      history: [],
      userText: `Conversa:\n${transcript}`,
    });
    return { response };
  }

  private async runStt(audioBuffer: Buffer, context: TurnContext): Promise<string> {
    return new Promise((resolve, reject) => {
      let finalTranscript = "";

      this.stt
        .streamingTranscribe({
          sampleRate: 16000,
          language: "pt",
          onPartial: () => { /* no-op for now */ },
          onFinal: (text) => {
            finalTranscript = text;
          },
          onError: reject,
        })
        .then(({ sendAudio, finish }) => {
          // Send the buffered audio in chunks of 3200 bytes (~100ms frames at 16kHz 16-bit)
          const CHUNK = 3200;
          for (let i = 0; i < audioBuffer.length; i += CHUNK) {
            sendAudio(audioBuffer.subarray(i, i + CHUNK));
          }
          return finish();
        })
        .then(() => resolve(finalTranscript))
        .catch(reject);
    });
  }
}
