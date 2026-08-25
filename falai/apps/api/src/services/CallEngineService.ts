import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import type { CallStatus, BillingMode } from "@falai/db";
import type { CallEvent } from "@falai/shared";
import type { TelephonyProvider, TurnMessage, LlmProvider } from "@falai/providers";
import { VadDetector } from "./VadDetector.js";
import type { TurnProcessor } from "./TurnProcessor.js";
import type { AudioCache } from "./AudioCache.js";
import { settleCall } from "./billing.service.js";
import { resolveModelForAgent, isModelBlocked } from "./modelResolver.service.js";

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
  // Motor de IA desta chamada. Resolvido uma vez no arranque da sessão: sem
  // isto seria uma ida à base de dados por turno. Null = motor da plataforma.
  llm: LlmProvider | null;
  modelId: string | null;
  maxReplyChars: number | null;
  /** Números para onde esta chamada pode ser transferida (guardrail de escalate). */
  allowedEscalationNumbers: string[];
  // Billing
  reservedCents: number;
  billingMode: BillingMode;
  pricePerMinuteCents: number;
  pricePerCallCents: number;

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
    billingMode?: BillingMode;
    pricePerMinuteCents?: number;
    pricePerCallCents?: number;
  }): Promise<void> {
    // Registar uma chamada era uma operação puramente em memória e não pode
    // deixar de o ser na prática: se a base de dados estiver lenta ou em baixo,
    // a chamada tem de continuar a ser registada. Em caso de falha usa-se o
    // motor da plataforma e só o número de escalate do agente — mais restrito,
    // nunca mais permissivo.
    let model = { llm: null, modelId: null } as Awaited<ReturnType<typeof resolveModelForAgent>>;
    let allowedEscalationNumbers: string[] = [];

    try {
      // Que motor responde nesta chamada — o nosso ou o do cliente. Resolvido
      // aqui, uma vez, e não a cada turno. Um modelo que não esteja ACTIVE cai
      // para o motor da plataforma; ver modelResolver.service.ts.
      model = await resolveModelForAgent(params.agentId);

      // Para onde é lícito transferir esta chamada. Sem isto, um modelo do
      // cliente podia devolver `escalate` para um número qualquer e desviar a
      // chamada do cliente final. Ver guardrail.service.ts.
      const lines = await prisma.tenantLine.findMany({
        where: { tenantId: params.tenantId, isActive: true },
        select: { phoneNumber: true, extension: true },
      });
      allowedEscalationNumbers = [
        params.escalationNumber,
        ...lines.map((l) => l.phoneNumber),
        ...lines.map((l) => l.extension),
      ].filter((n): n is string => typeof n === "string" && n.trim() !== "");
    } catch (err) {
      this.cfg.log.error(
        { err, callId: params.callId, agentId: params.agentId },
        "call_engine.model_resolve_failed"
      );
      allowedEscalationNumbers = params.escalationNumber ? [params.escalationNumber] : [];
    }

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
      llm: model.llm,
      modelId: model.modelId,
      maxReplyChars: model.maxReplyChars ?? null,
      allowedEscalationNumbers,
      reservedCents: params.reservedCents ?? 0,
      billingMode: params.billingMode ?? "PER_MINUTE",
      pricePerMinuteCents: params.pricePerMinuteCents ?? 0,
      pricePerCallCents: params.pricePerCallCents ?? 0,
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
    this.cfg.log.info(
      {
        callId: params.callId,
        providerCallId: params.providerCallId,
        modelId: model.modelId ?? "platform",
      },
      "call_engine.registered"
    );
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

    // Kill switch a meio da chamada. O modelo foi resolvido no arranque e vive
    // na sessão; sem esta verificação, bloqueá-lo no backoffice não calava
    // as chamadas que já estavam a decorrer. A chamada não cai — passa a
    // responder pelo motor da plataforma a partir do turno seguinte.
    if (session.modelId && isModelBlocked(session.modelId)) {
      this.cfg.log.warn(
        { callId: session.callId, modelId: session.modelId },
        "call_engine.model_blocked_midcall"
      );
      session.llm = null;
      session.modelId = null;
      session.maxReplyChars = null;
    }

    try {
      const result = await this.cfg.turnProcessor.processTurn(audioBuffer, {
        callId: session.callId,
        agentId: session.agentId,
        tenantId: session.tenantId,
        toNumber: session.toNumber,
        providerCallId: session.providerCallId,
        systemPrompt: session.systemPrompt,
        ttsVoiceId: session.ttsVoiceId,
        variables: session.variables,
        history: session.history,
        seq: session.turnSeq,
        modelId: session.modelId,
        allowedEscalationNumbers: session.allowedEscalationNumbers,
        ...(session.llm !== null && { llm: session.llm }),
        ...(session.maxReplyChars !== null && { maxReplyChars: session.maxReplyChars }),
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
        reservedCents: session.reservedCents,
        price: {
          billingMode: session.billingMode,
          pricePerMinuteCents: session.pricePerMinuteCents,
          pricePerCallCents: session.pricePerCallCents,
        },
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

  /**
   * Text-only LLM simulation — no audio, no telephony. Used by simulators.
   *
   * `llm` permite simular contra o modelo do próprio cliente antes de este
   * estar aprovado. Os guardrails correm na mesma e os que dispararem vêm em
   * `guardrailFlags`, para quem está a afinar ver ao que fica sujeito.
   */
  async simulateTurn(params: {
    userText: string;
    systemPrompt: string;
    history: TurnMessage[];
    variables: Record<string, unknown>;
    llm?: LlmProvider;
    tenantId?: string;
    maxReplyChars?: number;
  }): Promise<{
    reply: string;
    action: import("@falai/shared").LlmTurnResponse["action"];
    llmMs: number;
    guardrailFlags: string[];
  }> {
    return this.cfg.turnProcessor.simulateTurn(params);
  }

  get activeCallCount(): number { return this.sessions.size; }
  get audioCache(): AudioCache { return this.cfg.audioCache; }
}
