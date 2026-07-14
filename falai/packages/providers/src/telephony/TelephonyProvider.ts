import type { CallEvent } from "@falai/shared";

export interface DialParams {
  fromExtension: string;
  to: string;
  ref: string;
  /**
   * "yes" → a extensão de origem atende automaticamente (intercom) — usado no fluxo de IA
   * para fazer a ponte de media. "no" → a origem toca normalmente (o humano atende no
   * telefone). Default "yes" para preservar o comportamento do motor de IA.
   */
  autoAnswer?: "yes" | "no";
}

export interface PlayPromptParams {
  number: string;
  prompts: string[];
  volume?: number;
  /** Internal call ID — used by stub mode to fire PROMPT_FINISHED events. Not sent to real Yeastar. */
  providerCallId?: string;
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
