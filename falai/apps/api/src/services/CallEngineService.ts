import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import type { CallStatus } from "@falai/db";
import type { CallEvent } from "@falai/shared";
import type { TelephonyProvider, TurnMessage } from "@falai/providers";
import { VadDetector } from "./VadDetector.js";
import type { TurnProcessor } from "./TurnProcessor.js";
import type { AudioCache } from "./AudioCache.js";
import { settleCall } from "./billing.service.js";

type AudioCacheKey = Parameters<AudioCache["getPromptName"]>[0];

// State per active call
interface CallSession {
  callId: string;
  agentId: string;
  tenantId: string;
  toNumber: string;
  providerCallId: string;
  systemPrompt: string;
  ttsVoiceId: string;
  variables: Record<string, unknown>;
  maxCallSeconds: number;
  maxTurnSeconds: number;
  escalationNumber: string | null;
  // Billing
  reservedCents: number;
  pricePerMinuteCents: number;

  state: "DIALING" | "RINGING" | "IN_PROGRESS" | "AWAITING_SPEECH" | "PROCESSING_TURN" | "TERMINATED";
  history: TurnMessage[];
  turnSeq: number;
  startedAt: Date;
  answeredAt: Date | null;
  vad: VadDetector | null;
  maxCallTimer: ReturnType<typeof setTimeout> | null;
  silenceTimer: ReturnType<typeof setTimeout> | null;
}

export interface CallEngineConfig {
  telephony: TelephonyProvider;
  turnProcessor: TurnProcessor;
  audioCache: AudioCache;
  log: FastifyBaseLogger;
  /** Optional hook — fired after every call ends (for webhook delivery). */
  onCallEnded?: (params: { callId: string; tenantId: string; status: CallStatus; durationSecs: number }) => void;
}

export class CallEngineService {
  private sessions = new Map<string, CallSession>();
  private callIndex = new Map<string, string>();
  private cfg: CallEngineConfig;

  constructor(cfg: CallEngineConfig) {
    this.cfg = cfg;
  }

  async registerCall(params: {
    callId: string;
    agentId: string;
    tenantId: string;
    toNumber: string;
    providerCallId: string;
    systemPrompt: string;
    ttsVoiceId: string;
    variables?: Record<string, unknown>;
    maxCallSeconds?: number;
    maxTurnSeconds?: number;
    escalationNumber?: string | null;
    reservedCents?: number;
    pricePerMinuteCents?: number;
  }): Promise<void> {
    const session: CallSession = {
      callId: params.callId,
      agentId: params.agentId,
      tenantId: params.tenantId,
      toNumber: params.toNumber,
      providerCallId: params.providerCallId,
      systemPrompt: params.systemPrompt,
      ttsVoiceId: params.ttsVoiceId,
      variables: params.variables ?? {},
      maxCallSeconds: params.maxCallSeconds ?? 300,
      maxTurnSeconds: params.maxTurnSeconds ?? 30,
      escalationNumber: params.escalationNumber ?? null,
      reservedCents: params.reservedCents ?? 0,
      pricePerMinuteCents: params.pricePerMinuteCents ?? 0,
      state: "DIALING",
      history: [],
      turnSeq: 0,
      startedAt: new Date(),
      answeredAt: null,
      vad: null,
      maxCallTimer: null,
      silenceTimer: null,
    };

    this.sessions.set(params.providerCallId, session);
    this.callIndex.set(params.callId, params.providerCallId);
    this.cfg.log.info({ callId: params.callId, providerCallId: params.providerCallId }, "call_engine.registered");
  }

  async handleEvent(event: CallEvent): Promise<void> {
    const session = this.sessions.get(event.providerCallId);
    if (!session) return;

    this.cfg.log.info({ callId: session.callId, event: event.type }, "call_engine.event");

    try {
      switch (event.type) {
        case "CALL_RINGING":   await this.onRinging(session); break;
        case "CALL_ANSWERED":  await this.onAnswered(session, event.answeredAt); break;
        case "CALL_ENDED":     await this.onCallEnded(session, event.durationSecs, event.hangupCause); break;
        case "CALL_FAILED":    await this.onCallFailed(session, event.reason); break;
        case "PROMPT_FINISHED":await this.onPromptFinished(session); break;
        case "DTMF":
          this.cfg.log.info({ callId: session.callId, digit: event.digit }, "call_engine.dtmf");
          break;
        case "AUDIO_FRAME": break;
      }
    } catch (err) {
      this.cfg.log.error({ err, callId: session.callId }, "call_engine.event_error");
      await this.terminateCall(session, "FAILED", "Internal engine error");
    }
  }

  handleAudioFrame(providerCallId: string, frame: Buffer): void {
    const session = this.sessions.get(providerCallId);
    if (!session || session.state !== "AWAITING_SPEECH" || !session.vad) return;
    session.vad.push(frame);
  }

  private async onRinging(session: CallSession): Promise<void> {
    session.state = "RINGING";
    await prisma.call.update({ where: { id: session.callId }, data: { status: "RINGING" } });
  }

  private async onAnswered(session: CallSession, answeredAt: Date): Promise<void> {
    session.state = "IN_PROGRESS";
    session.answeredAt = answeredAt;
    await prisma.call.update({
      where: { id: session.callId },
      data: { status: "IN_PROGRESS", answeredAt },
    });

    session.maxCallTimer = setTimeout(() => { void this.handleMaxDuration(session); }, session.maxCallSeconds * 1000);
    await this.playSystemPrompt(session, "greeting");
  }

  private async onPromptFinished(session: CallSession): Promise<void> {
    if (session.state === "TERMINATED") return;
    session.state = "AWAITING_SPEECH";
    this.startSpeechListening(session);
  }

  private startSpeechListening(session: CallSession): void {
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }

    session.vad = new VadDetector(
      (audio) => {
        if (session.state !== "AWAITING_SPEECH") return;
        session.state = "PROCESSING_TURN";
        void this.processTurn(session, audio);
      },
      () => {
        if (session.state !== "AWAITING_SPEECH") return;
        session.state = "PROCESSING_TURN";
        void this.processTurn(session, Buffer.alloc(0));
      },
      { silenceMs: 800, maxBufferMs: session.maxTurnSeconds * 1000 }
    );

    session.silenceTimer = setTimeout(() => {
      if (session.state !== "AWAITING_SPEECH") return;
      session.vad?.flushRemaining();
      void this.playSystemPrompt(session, "not_understood");
    }, session.maxTurnSeconds * 1000);
  }

  private async processTurn(session: CallSession, audioBuffer: Buffer): Promise<void> {
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }
    session.turnSeq++;

    try {
      const result = await this.cfg.turnProcessor.processTurn(audioBuffer, {
        callId: session.callId,
        agentId: session.agentId,
        toNumber: session.toNumber,
        providerCallId: session.providerCallId,
        systemPrompt: session.systemPrompt,
        ttsVoiceId: session.ttsVoiceId,
        variables: session.variables,
        history: session.history,
        seq: session.turnSeq,
      });

      this.cfg.log.info({
        callId: session.callId,
        seq: session.turnSeq,
        action: result.response.action.type,
        latencies: result.latencies,
      }, "call_engine.turn_complete");

      if (result.transcript) session.history.push({ role: "human", text: result.transcript });
      session.history.push({ role: "agent", text: result.response.reply });

      // Detect opt-out keywords
      const lower = result.transcript.toLowerCase();
      const isOptOut = ["não me contacte", "não ligue", "remova", "lista negra"].some((kw) => lower.includes(kw));
      if (isOptOut) { await this.handleOptOut(session); return; }

      switch (result.response.action.type) {
        case "end_call":
          session.state = "IN_PROGRESS";
          setTimeout(() => { void this.terminateCall(session, "COMPLETED"); }, 2000);
          break;
        case "escalate":
          await this.handleEscalation(session, result.response.action.to);
          break;
        case "capture":
          await prisma.call.update({
            where: { id: session.callId },
            data: { outcome: JSON.stringify(result.response.action.data) },
          });
          session.state = "IN_PROGRESS";
          break;
        default:
          session.state = "IN_PROGRESS";
          break;
      }
    } catch (err) {
      this.cfg.log.error({ err, callId: session.callId }, "call_engine.turn_error");
      await this.playSystemPrompt(session, "not_understood");
    }
  }

  private async handleMaxDuration(session: CallSession): Promise<void> {
    if (session.state === "TERMINATED") return;
    this.cfg.log.info({ callId: session.callId }, "call_engine.max_duration");
    await this.playSystemPrompt(session, "farewell");
    setTimeout(() => { void this.terminateCall(session, "COMPLETED"); }, 3000);
  }

  private async handleOptOut(session: CallSession): Promise<void> {
    const call = await prisma.call.findUnique({ where: { id: session.callId }, select: { contactId: true } });
    if (call?.contactId) {
      await prisma.contact.update({ where: { id: call.contactId }, data: { optedOutAt: new Date() } });
    }
    await prisma.call.update({ where: { id: session.callId }, data: { outcome: "OPT_OUT" } });
    await this.terminateCall(session, "COMPLETED");
  }

  private async handleEscalation(session: CallSession, to?: string): Promise<void> {
    const escalateTo = to ?? session.escalationNumber ?? undefined;
    if (escalateTo) {
      try { await this.cfg.telephony.transfer(session.providerCallId, escalateTo); } catch { /* best-effort */ }
    }
    await this.terminateCall(session, "ESCALATED");
  }

  private async onCallEnded(session: CallSession, durationSecs: number, hangupCause: string): Promise<void> {
    if (session.state === "TERMINATED") return;
    const status: CallStatus = hangupCause === "NO_ANSWER" ? "NO_ANSWER"
      : hangupCause === "USER_BUSY" ? "BUSY"
      : "COMPLETED";
    await this.cleanupSession(session, status, durationSecs);
  }

  private async onCallFailed(session: CallSession, reason: string): Promise<void> {
    await this.cleanupSession(session, "FAILED", 0, reason);
  }

  private async terminateCall(
    session: CallSession,
    finalStatus: CallStatus,
    failReason?: string
  ): Promise<void> {
    if (session.state === "TERMINATED") return;
    session.state = "TERMINATED";
    try { await this.cfg.telephony.hangup(session.providerCallId); } catch { /* best-effort */ }
    await this.cleanupSession(session, finalStatus, undefined, failReason);
  }

  private async cleanupSession(
    session: CallSession,
    status: CallStatus,
    durationSecs?: number,
    failReason?: string
  ): Promise<void> {
    session.state = "TERMINATED";
    if (session.maxCallTimer) clearTimeout(session.maxCallTimer);
    if (session.silenceTimer) clearTimeout(session.silenceTimer);

    const endedAt = new Date();
    const duration = durationSecs ?? (session.answeredAt
      ? Math.floor((endedAt.getTime() - session.answeredAt.getTime()) / 1000)
      : 0);

    await prisma.call.update({
      where: { id: session.callId },
      data: {
        status,
        endedAt,
        durationSecs: duration,
        ...(failReason !== undefined && { failReason }),
      },
    });

    if (session.history.length > 0) void this.generateCallSummary(session);

    // Settle billing for campaign/dispatcher calls
    if (session.reservedCents > 0) {
      settleCall({
        callId: session.callId,
        tenantId: session.tenantId,
        billedSecs: duration,
        pricePerMinuteCents: session.pricePerMinuteCents,
        reservedCents: session.reservedCents,
      }).catch((err) => this.cfg.log.error({ err, callId: session.callId }, "billing.settle_failed"));
    }

    this.sessions.delete(session.providerCallId);
    this.callIndex.delete(session.callId);

    this.cfg.log.info({ callId: session.callId, status, durationSecs: duration }, "call_engine.call_ended");

    if (this.cfg.onCallEnded) {
      this.cfg.onCallEnded({ callId: session.callId, tenantId: session.tenantId, status, durationSecs: duration });
    }
  }

  private async generateCallSummary(session: CallSession): Promise<void> {
    try {
      const transcript = session.history
        .map((m) => `${m.role === "agent" ? "Agente" : "Cliente"}: ${m.text}`)
        .join("\n");
      const { response } = await this.cfg.turnProcessor.runSttLlmForSummary(transcript);
      await prisma.call.update({ where: { id: session.callId }, data: { summary: response.reply } });
    } catch { /* non-critical */ }
  }

  private async playSystemPrompt(session: CallSession, key: AudioCacheKey): Promise<void> {
    const promptName = this.cfg.audioCache.getPromptName(key);
    await this.cfg.telephony.playPrompt({
      number: session.toNumber,
      prompts: [promptName],
      providerCallId: session.providerCallId,
    });
  }

  /** Text-only LLM simulation — no audio, no telephony. Used by simulators. */
  async simulateTurn(params: {
    userText: string;
    systemPrompt: string;
    history: TurnMessage[];
    variables: Record<string, unknown>;
  }): Promise<{ reply: string; action: import("@falai/shared").LlmTurnResponse["action"]; llmMs: number }> {
    return this.cfg.turnProcessor.simulateTurn(params);
  }

  get activeCallCount(): number { return this.sessions.size; }
}
