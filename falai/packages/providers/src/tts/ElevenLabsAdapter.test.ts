import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsAdapter } from "./ElevenLabsAdapter.js";

const ok = () => new Response(new Uint8Array(32), { status: 200 });
const tooMany = () =>
  new Response('{"detail":{"code":"concurrent_limit_exceeded"}}', { status: 429 });

describe("ElevenLabsAdapter.synthesize", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tenta de novo em 429 e acaba por devolver o áudio", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(tooMany()).mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    const tts = new ElevenLabsAdapter({ apiKey: "k", retryBaseMs: 1 });

    const out = await tts.synthesize({ text: "olá", voiceId: "v" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.wavBuffer.length).toBe(44 + 32);
  });

  it("desiste depois de maxRetries", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tooMany());
    vi.stubGlobal("fetch", fetchMock);
    const tts = new ElevenLabsAdapter({ apiKey: "k", retryBaseMs: 1, maxRetries: 2 });

    await expect(tts.synthesize({ text: "olá", voiceId: "v" })).rejects.toThrow(/\(429\)/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("não repete outros erros", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("bad", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const tts = new ElevenLabsAdapter({ apiKey: "k", retryBaseMs: 1 });

    await expect(tts.synthesize({ text: "olá", voiceId: "v" })).rejects.toThrow(/\(401\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("nunca tem mais de maxConcurrent pedidos em paralelo", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok();
    }));
    const tts = new ElevenLabsAdapter({ apiKey: "k", maxConcurrent: 2 });

    await Promise.all(Array.from({ length: 6 }, () => tts.synthesize({ text: "olá", voiceId: "v" })));
    expect(peak).toBe(2);
  });
});
