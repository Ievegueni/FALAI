import type { CallEvent } from "@falai/shared";

export interface DialParams {
  fromExtension: string;
  to: string;
  ref: string;
  /**
   * Tenant a quem a chamada pertence. Decide por que trunk ela sai: o próprio
   * do cliente, se existir, senão um partilhado. Sem isto usava-se o primeiro
   * trunk activo — o de outro cliente, com o Caller ID dele.
   */
  tenantId?: string;
  /**
   * "yes" → a extensão de origem atende automaticamente (intercom) — usado no fluxo de IA
   * para fazer a ponte de media. "no" → a origem toca normalmente (o humano atende no
   * telefone). Default "yes" para preservar o comportamento do motor de IA.
   */
  autoAnswer?: "yes" | "no";
  /**
   * Extensão cujas permissões de saída (outbound route) são usadas para a chamada.
   * Por defeito é igual a fromExtension. Útil quando a extensão de origem não tem
   * permissões de saída para números externos — usa-se uma extensão com trunk configurado.
   */
  dialPermission?: string;
}

export interface PlayPromptParams {
  number: string;
  prompts: string[];
  volume?: number;
  /** Número de repetições da sequência de prompts (default 1 no Yeastar). */
  count?: number;
  /**
   * Quando presente, o Yeastar coloca uma chamada de saída para `number` e toca os
   * prompts (fluxo de anúncio/OTP). `dialPermission` é a extensão cujas permissões de
   * saída (outbound route) são usadas para chegar a números externos.
   */
  dialPermission?: string;
  /** "yes"/"no" — comportamento de atendimento automático da chamada de anúncio. */
  autoAnswer?: "yes" | "no";
  /** Internal call ID — used by stub mode to fire PROMPT_FINISHED events. Not sent to real Yeastar. */
  providerCallId?: string;
  /** Tenant da chamada — decide o trunk de saída no motor Asterisk. */
  tenantId?: string;
}

export interface TelephonyProvider {
  dial(params: DialParams): Promise<{ providerCallId: string }>;
  hangup(providerCallId: string): Promise<void>;
  transfer(providerCallId: string, to: string): Promise<void>;
  uploadPrompt(name: string, wavBuffer: Buffer): Promise<void>;
  playPrompt(params: PlayPromptParams): Promise<void>;
  subscribeToEvents(handler: (event: CallEvent) => void): Promise<void>;
  unsubscribeFromEvents(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}
