export type { TelephonyProvider, DialParams, PlayPromptParams } from "./telephony/TelephonyProvider.js";
export { YeastarAdapter, YeastarError } from "./telephony/YeastarAdapter.js";
export type { YeastarConfig, YeastarCdrRecord } from "./telephony/YeastarAdapter.js";
export { AsteriskAdapter, AsteriskError } from "./telephony/AsteriskAdapter.js";
export type { AsteriskConfig } from "./telephony/AsteriskAdapter.js";
export {
  trunkEndpointId,
  extensionEndpointId,
  extensionWebEndpointId,
  sipAuthUserFromEndpointId,
  formatDialNumber,
  parseDialFormat,
} from "./telephony/asteriskNaming.js";
export type { DialFormat } from "./telephony/asteriskNaming.js";
export { NoopTrunkRuntimeAdapter } from "./telephony/TrunkRuntimeAdapter.js";
export type {
  TrunkRuntimeAdapter,
  PbxSyncPayload,
  PbxSyncResult,
  SipTrunkConfig,
  SipExtensionConfig,
  OutboundRouteConfig,
  InboundRouteConfig,
} from "./telephony/TrunkRuntimeAdapter.js";

export type { SttProvider } from "./stt/SttProvider.js";
export { DeepgramAdapter } from "./stt/DeepgramAdapter.js";
export type { DeepgramConfig } from "./stt/DeepgramAdapter.js";

export type { LlmProvider, TurnMessage } from "./llm/LlmProvider.js";
export { ClaudeAdapter } from "./llm/ClaudeAdapter.js";
export type { ClaudeConfig } from "./llm/ClaudeAdapter.js";

export type { TtsProvider } from "./tts/TtsProvider.js";
export { ElevenLabsAdapter, silentWav } from "./tts/ElevenLabsAdapter.js";
export type { ElevenLabsConfig } from "./tts/ElevenLabsAdapter.js";
export { MacOsTtsAdapter } from "./tts/MacOsTtsAdapter.js";

export type { SmsProvider, SendSmsParams, SendSmsResult } from "./sms/SmsProvider.js";
export { countSegments } from "./sms/SmsProvider.js";
export { FuturixAdapter } from "./sms/FuturixAdapter.js";
export type { FuturixConfig } from "./sms/FuturixAdapter.js";
