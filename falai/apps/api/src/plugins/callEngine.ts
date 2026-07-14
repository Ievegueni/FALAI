import fp from "fastify-plugin";
import { Queue } from "bullmq";
import { DeepgramAdapter, ClaudeAdapter, ElevenLabsAdapter } from "@falai/providers";
import type { YeastarAdapter } from "@falai/providers";
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

  const llm = new ClaudeAdapter({
    apiKey: providers.anthropic.apiKey,
    model: "claude-sonnet-4-6",
    stubMode: stubMode || !providers.anthropic.apiKey,
  });

  const tts = new ElevenLabsAdapter({
    apiKey: providers.elevenlabs.apiKey,
    stubMode: stubMode || !providers.elevenlabs.apiKey,
  });

  const defaultVoiceId = providers.elevenlabs.defaultVoiceId;

  const audioCache = new AudioCache(fastify.redis, tts, fastify.yeastar as YeastarAdapter, defaultVoiceId);
  const turnProcessor = new TurnProcessor(stt, llm, tts, fastify.yeastar as YeastarAdapter, audioCache);
  const webhooksQueue = new Queue(QUEUES.WEBHOOKS_OUT, {
    connection: { url: config.REDIS_URL },
  });

  const callEngine = new CallEngineService({
    telephony: fastify.yeastar as YeastarAdapter,
    turnProcessor,
    audioCache,
    log: fastify.log,
    onCallEnded: ({ callId, tenantId, status, durationSecs }) => {
      // Settle campaign contact (retry or mark done)
      settleCampaignContact({ callId, tenantId, status, log: fastify.log })
        .catch((err) => fastify.log.error({ err, callId }, "settlement.failed"));

      // Enqueue webhook delivery if tenant has a URL configured
      prisma.tenant
        .findUnique({ where: { id: tenantId }, select: { webhookUrl: true } })
        .then((tenant) => {
          if (!tenant?.webhookUrl) return;
          return webhooksQueue.add(
            JOBS.DELIVER_WEBHOOK,
            { callId, tenantId, event: "call.ended", payload: { callId, tenantId, status, durationSecs } },
            { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
          );
        })
        .catch((err) => fastify.log.error({ err, callId }, "webhook.enqueue_failed"));
    },
  });

  // Wire Yeastar events to call engine (replaces the placeholder in index.ts)
  await (fastify.yeastar as YeastarAdapter).subscribeToEvents(async (event) => {
    await callEngine.handleEvent(event);
  });

  // Warm up common audio prompts in background
  audioCache.warmUp().catch((err) => fastify.log.error({ err }, "audio_cache.warmup_failed"));

  fastify.decorate("callEngine", callEngine);

  fastify.log.info({
    sttStub: stubMode || !providers.deepgram.apiKey,
    llmStub: stubMode || !providers.anthropic.apiKey,
    ttsStub: stubMode || !providers.elevenlabs.apiKey,
  }, "call_engine.initialized");
});
