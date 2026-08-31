import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { DeepgramAdapter, ClaudeAdapter, ElevenLabsAdapter, MacOsTtsAdapter } from "@falai/providers";
import type { TtsProvider } from "@falai/providers";
import { prisma } from "@falai/db";
import { config } from "../config.js";
import { QUEUES, JOBS } from "@falai/shared";
import { AudioCache } from "../services/AudioCache.js";
import { TurnProcessor } from "../services/TurnProcessor.js";
import { CallEngineService } from "../services/CallEngineService.js";
import { settleCampaignContact } from "../services/callSettlement.service.js";

declare module "fastify" {
  interface FastifyInstance {
    callEngine: CallEngineService;
    /** True quando o LLM corre em modo stub (sem chave real) — respostas não são IA real. */
    llmStub: boolean;
  }
}

export default fp(async (fastify) => {
  const providers = fastify.providerConfig;
  const stubMode = providers.yeastar.stubMode;

  const stt = new DeepgramAdapter({
    apiKey: providers.deepgram.apiKey,
    model: "nova-2",
    language: "pt",
    stubMode: stubMode || !providers.deepgram.apiKey,
  });

  const llmStub = stubMode || !providers.anthropic.apiKey;
  const llm = new ClaudeAdapter({
    apiKey: providers.anthropic.apiKey,
    model: "claude-sonnet-4-6",
    stubMode: llmStub,
  });

  // TTS_PROVIDER=macos usa say+afconvert localmente (sem API externa)
  const useMacTts = process.env["TTS_PROVIDER"] === "macos";
  const tts: TtsProvider = useMacTts
    ? new MacOsTtsAdapter("Joana")
    : new ElevenLabsAdapter({
        apiKey: providers.elevenlabs.apiKey,
        stubMode: stubMode || !providers.elevenlabs.apiKey,
      });

  const defaultVoiceId = useMacTts ? "Joana" : providers.elevenlabs.defaultVoiceId;

  const audioCache = new AudioCache(fastify.redis, tts, fastify.telephony, defaultVoiceId);
  const turnProcessor = new TurnProcessor(stt, llm, tts, fastify.telephony, audioCache);
  const webhooksQueue = new Queue(QUEUES.WEBHOOKS_OUT, {
    connection: { url: config.REDIS_URL },
  });

  const callEngine = new CallEngineService({
    telephony: fastify.telephony,
    turnProcessor,
    audioCache,
    log: fastify.log,
    onCallEnded: ({ callId, tenantId, status, durationSecs }) => {
      // Settle campaign contact (retry or mark done)
      settleCampaignContact({ callId, tenantId, status, log: fastify.log })
        .catch((err) => fastify.log.error({ err, callId }, "settlement.failed"));

      // Enqueue webhook delivery if tenant has a URL configured
      Promise.all([
        prisma.tenant.findUnique({ where: { id: tenantId }, select: { webhookUrl: true } }),
        prisma.call.findUnique({
          where: { id: callId },
          select: { campaignId: true, contactId: true, toNumber: true, outcome: true, failReason: true, costCents: true, recordingUrl: true },
        }),
      ])
        .then(([tenant, call]) => {
          if (!tenant?.webhookUrl) return;
          return webhooksQueue.add(
            JOBS.DELIVER_WEBHOOK,
            {
              callId,
              tenantId,
              event: "call.ended",
              payload: {
                callId,
                tenantId,
                status,
                durationSecs,
                campaignId: call?.campaignId ?? null,
                contactId: call?.contactId ?? null,
                toNumber: call?.toNumber ?? null,
                outcome: call?.outcome ?? null,
                failReason: call?.failReason ?? null,
                costCents: call?.costCents ?? 0,
                recordingUrl: call?.recordingUrl ?? null,
              },
            },
            { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
          );
        })
        .catch((err) => fastify.log.error({ err, callId }, "webhook.enqueue_failed"));
    },
  });

  // Regista no eventBus (multiplexor) em vez de subscribeToEvents directo
  fastify.onCallEvent(async (event) => {
    await callEngine.handleEvent(event);
  });

  // Warm up common audio prompts in background
  audioCache.warmUp().catch((err) => fastify.log.error({ err }, "audio_cache.warmup_failed"));

  fastify.decorate("callEngine", callEngine);
  fastify.decorate("llmStub", llmStub);

  fastify.log.info({
    sttStub: stubMode || !providers.deepgram.apiKey,
    llmStub,
    ttsStub: stubMode || !providers.elevenlabs.apiKey,
  }, "call_engine.initialized");
});
