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
  // Chamada de entrada nova, ainda sem nenhum Call/ref conhecido no engine —
  // distinto de CALL_RINGING (que é sempre uma chamada já originada por nós
  // via dial()). did = número/EXTEN que o dialplan entregou ao Stasis.
  // tenantId vem preenchido quando a chamada entrou por um trunk exclusivo de
  // um cliente (peering por IP): aí sabe-se de quem é a chamada pelo caminho
  // por onde entrou, sem depender de o DID ser único entre clientes. Ausente
  // num trunk partilhado, onde o tenant se resolve a partir do DID.
  | { type: "INBOUND_CALL_STARTED"; providerCallId: string; did: string; callerIdNum?: string; tenantId?: string }
  | { type: "CALL_RINGING"; providerCallId: string }
  | { type: "CALL_ANSWERED"; providerCallId: string; answeredAt: Date }
  | { type: "CALL_ENDED"; providerCallId: string; endedAt: Date; durationSecs: number; hangupCause: string }
  | { type: "CALL_FAILED"; providerCallId: string; reason: string }
  // playbackId identifica o áudio concreto que acabou. O IVR precisa dele para
  // ignorar o fim de um anúncio que ele próprio já cortou (tecla premida a
  // meio) e não confundi-lo com o fim do anúncio que está a tocar agora.
  | { type: "PROMPT_FINISHED"; providerCallId: string; playbackId?: string }
  | { type: "DTMF"; providerCallId: string; digit: string }
  // Gravação de chamada. Estes eventos não trazem canal nenhum — quando a
  // gravação fecha, o canal já morreu. A ligação à chamada faz-se pelo nome,
  // que é o id da linha na tabela Call (ver callRecording.service.ts).
  | { type: "RECORDING_FINISHED"; recordingName: string; format: string; durationSecs?: number }
  | { type: "RECORDING_FAILED"; recordingName: string; reason: string }
  | { type: "AUDIO_FRAME"; providerCallId: string; data: Buffer; sampleRate: number };

/** Eventos ligados a um canal concreto — todos menos os de gravação. */
export type ChannelCallEvent = Extract<CallEvent, { providerCallId: string }>;

/**
 * Os eventos de gravação chegam sem canal (quando a gravação fecha, o canal já
 * morreu). Quem trabalha por canal — o motor de conversa, as chamadas de teste —
 * usa isto para os deixar passar em vez de assumir que há sempre providerCallId.
 */
export function isChannelCallEvent(event: CallEvent): event is ChannelCallEvent {
  return "providerCallId" in event;
}

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
  RECONCILE_STALE_CALLS: "reconcile-stale-calls",
} as const;
