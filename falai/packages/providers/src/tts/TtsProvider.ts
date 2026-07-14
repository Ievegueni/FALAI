export interface TtsProvider {
  synthesize(params: {
    text: string;
    voiceId: string;
    language?: string;
  }): Promise<{ wavBuffer: Buffer; durationMs: number; characters: number }>;

  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}
