import type { LlmTurnResponse } from "@falai/shared";

export interface TurnMessage {
  role: "agent" | "human" | "system";
  text: string;
}

export interface LlmProvider {
  generateTurnResponse(params: {
    systemPrompt: string;
    history: TurnMessage[];
    userText: string;
    variables?: Record<string, unknown>;
  }): Promise<{ response: LlmTurnResponse; durationMs: number; inputTokens: number; outputTokens: number }>;

  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}
