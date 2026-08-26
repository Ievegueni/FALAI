import fp from "fastify-plugin";
import { DeepgramAdapter, ClaudeAdapter, ElevenLabsAdapter, MacOsTtsAdapter } from "@falai/providers";
import type { TtsProvider } from "@falai/providers";
import { prisma } from "@falai/db";
import { AudioCache } from "../services/AudioCache.js";
import { TurnProcessor } from "../services/TurnProcessor.js";
import { CallEngineService } from "../services/CallEngineService.js";
import { settleCampaignContact } from "../services/callSettlement.service.js";
import { emitWebhook } from "../services/webhookEmitter.service.js";

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

  const callEngine = new CallEngineService({
    telephony: fastify.telephony,
    turnProcessor,
    audioCache,
    log: fastify.log,
    onCallEnded: ({ callId, tenantId, status, durationSecs }) => {
      // Settle campaign contact (retry or mark done)
      settleCampaignContact({ callId, tenantId, status, log: fastify.log })
        .catch((err) => fastify.log.error({ err, callId }, "settlement.failed"));

      // Webhook call.ended — inclui o desfecho e o motivo de falha para o cliente
      // poder classificar o contacto sem ter de voltar a chamar a API.
      prisma.call
        .findUnique({
          where: { id: callId },
          select: {
            campaignId: true, contactId: true, toNumber: true,
            outcome: true, failReason: true, costCents: true, recordingUrl: true,
          },
        })
        .then((call) =>
          emitWebhook({
            tenantId,
            callId,
            event: "call.ended",
            payload: {
              callId,
              status,
              durationSecs,
              outcome: call?.outcome ?? null,
              failReason: call?.failReason ?? null,
              costCents: call?.costCents ?? 0,
              recordingUrl: call?.recordingUrl ?? null,
              toNumber: call?.toNumber ?? null,
              campaignId: call?.campaignId ?? null,
              contactId: call?.contactId ?? null,
            },
          })
        )
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
