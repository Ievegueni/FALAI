/**
 * Energy-based Voice Activity Detector.
 * Buffers audio frames and fires onSpeechEnd when silence is detected
 * for longer than `silenceMs`.
 *
 * For 16-bit PCM: energy = mean of abs(sample values).
 * Threshold is configurable; sensible default for phone audio.
 */
export interface VadOptions {
  silenceMs?: number;       // silence window before declaring end-of-speech (default 800ms)
  energyThreshold?: number; // 0-32767, below = silence (default 500)
  sampleRate?: number;      // default 16000
  maxBufferMs?: number;     // hard limit on how much audio to buffer (default 15000ms)
}

export class VadDetector {
  private silenceMs: number;
  private energyThreshold: number;
  private sampleRate: number;
  private maxBufferMs: number;

  private audioChunks: Buffer[] = [];
  private silenceSince: number | null = null;
  private lastActivityAt = Date.now();
  private totalBufferedMs = 0;

  private onSpeechEnd: (audio: Buffer) => void;
  private onMaxBuffer: () => void;

  constructor(
    onSpeechEnd: (audio: Buffer) => void,
    onMaxBuffer: () => void,
    opts: VadOptions = {}
  ) {
    this.silenceMs = opts.silenceMs ?? 800;
    this.energyThreshold = opts.energyThreshold ?? 500;
    this.sampleRate = opts.sampleRate ?? 16000;
    this.maxBufferMs = opts.maxBufferMs ?? 15_000;
    this.onSpeechEnd = onSpeechEnd;
    this.onMaxBuffer = onMaxBuffer;
  }

  /** Feed a PCM-16 audio frame. Returns true if speech end was detected. */
  push(frame: Buffer): boolean {
    const energy = this.computeEnergy(frame);
    const bytesPerMs = (this.sampleRate * 2) / 1000; // 16-bit = 2 bytes/sample
    const frameDurationMs = frame.length / bytesPerMs;

    this.audioChunks.push(frame);
    this.totalBufferedMs += frameDurationMs;

    if (this.totalBufferedMs >= this.maxBufferMs) {
      this.onMaxBuffer();
      this.flush();
      return true;
    }

    if (energy < this.energyThreshold) {
      if (this.silenceSince === null) {
        this.silenceSince = Date.now();
      } else if (Date.now() - this.silenceSince >= this.silenceMs) {
        // Only fire if we actually have some speech (not just silence from the start)
        if (this.totalBufferedMs > this.silenceMs + 200) {
          this.onSpeechEnd(Buffer.concat(this.audioChunks));
        }
        this.flush();
        return true;
      }
    } else {
      this.silenceSince = null;
      this.lastActivityAt = Date.now();
    }

    return false;
  }

  /** Force flush — use when the call ends mid-speech. */
  flushRemaining(): void {
    if (this.audioChunks.length > 0) {
      this.onSpeechEnd(Buffer.concat(this.audioChunks));
      this.flush();
    }
  }

  private flush(): void {
    this.audioChunks = [];
    this.silenceSince = null;
    this.totalBufferedMs = 0;
  }

  private computeEnergy(frame: Buffer): number {
    if (frame.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < frame.length - 1; i += 2) {
      const sample = frame.readInt16LE(i);
      sum += Math.abs(sample);
    }
    return sum / (frame.length / 2);
  }

  get msSinceLastActivity(): number {
    return Date.now() - this.lastActivityAt;
  }
}
