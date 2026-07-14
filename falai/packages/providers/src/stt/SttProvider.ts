export interface SttProvider {
  // Opens a streaming session; returns a writable stream for audio frames
  // and emits transcript chunks via the callback
  streamingTranscribe(params: {
    sampleRate: number;
    language?: string;
    onPartial: (text: string) => void;
    onFinal: (text: string, durationMs: number) => void;
    onError: (err: Error) => void;
  }): Promise<{
    sendAudio: (frame: Buffer) => void;
    finish: () => Promise<void>;
  }>;

  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}
