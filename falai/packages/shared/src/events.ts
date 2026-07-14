// Yeastar event codes (webhook / WebSocket)
export const YEASTAR_EVENTS = {
  CALL_STATE_CHANGED: 30011,
  CALL_END: 30012,
  CALL_FAILURE: 30015,
  DTMF_DIGIT: 30017,
  PROMPT_PLAYBACK_COMPLETED: 30018,
} as const;

export type YeastarEventCode =
  (typeof YEASTAR_EVENTS)[keyof typeof YEASTAR_EVENTS];

// Internal normalised call event (provider-agnostic)
export type CallEvent =
  | { type: "CALL_INITIATED"; providerCallId: string; ref: string }
  | { type: "CALL_RINGING"; providerCallId: string }
  | { type: "CALL_ANSWERED"; providerCallId: string; answeredAt: Date }
  | { type: "CALL_ENDED"; providerCallId: string; endedAt: Date; durationSecs: number; hangupCause: string }
  | { type: "CALL_FAILED"; providerCallId: string; reason: string }
  | { type: "PROMPT_FINISHED"; providerCallId: string }
  | { type: "DTMF"; providerCallId: string; digit: string }
  | { type: "AUDIO_FRAME"; providerCallId: string; data: Buffer; sampleRate: number };

// BullMQ queue names
export const QUEUES = {
  CALL_ENGINE: "call-engine",
  DISPATCHER: "dispatcher",
  BILLING: "billing",
  WEBHOOKS_OUT: "webhooks-out",
  CONTACT_IMPORT: "contact-import",
  PURGE: "purge",
} as const;

// BullMQ job names
export const JOBS = {
  DIAL: "dial",
  PROCESS_TURN: "process-turn",
  HANGUP: "hangup",
  CHARGE_CALL: "charge-call",
  DELIVER_WEBHOOK: "deliver-webhook",
  IMPORT_CONTACTS: "import-contacts",
  DISPATCH_CAMPAIGN: "dispatch-campaign",
  MONTHLY_FEE: "monthly-fee",
} as const;
