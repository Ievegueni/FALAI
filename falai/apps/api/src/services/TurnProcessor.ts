import { prisma } from "@falai/db";
import type { SttProvider, LlmProvider, TtsProvider, TelephonyProvider, TurnMessage } from "@falai/providers";
import type { LlmTurnResponse } from "@falai/shared";
import type { AudioCache } from "./AudioCache.js";

export interface TurnContext {
  callId: string;
  agentId: string;
  toNumber: string;
  providerCallId: string;
  systemPrompt: string;
  ttsVoiceId: string;
  variables: Record<string, unknown>;
  history: TurnMessage[];
  seq: number;
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
    const llmStart = Date.now();
    const { response, durationMs: llmMs, inputTokens, outputTokens } = await this.llm.generateTurnResponse({
      systemPrompt: context.systemPrompt,
      history: context.history,
      userText: transcript || "(início da chamada — cumprimentar o utilizador)",
      variables: context.variables,
    });
    const agentText = response.reply;

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
      },
    });

    return {
      response,
      transcript,
      promptName,
      latencies: { sttMs, llmMs, ttsMs, playMs },
    };
  }

  /** LLM-only turn for text simulators (no STT/TTS/telephony). */
  async simulateTurn(params: {
    userText: string;
    systemPrompt: string;
    history: TurnMessage[];
    variables: Record<string, unknown>;
  }): Promise<{ reply: string; action: LlmTurnResponse["action"]; llmMs: number }> {
    const start = Date.now();
    const { response } = await this.llm.generateTurnResponse({
      systemPrompt: params.systemPrompt,
      history: params.history,
      userText: params.userText,
      variables: params.variables,
    });
    return { reply: response.reply, action: response.action, llmMs: Date.now() - start };
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
