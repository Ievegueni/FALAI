import { describe, expect, it, vi } from "vitest";
import { RoutingTtsAdapter } from "./RoutingTtsAdapter.js";
import type { TtsProvider } from "./TtsProvider.js";

function fake(tag: string, fail = false): TtsProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async synthesize({ voiceId }) {
      calls.push(voiceId);
      if (fail) throw new Error(`${tag} falhou`);
      return { wavBuffer: Buffer.from(tag), durationMs: 1, characters: 1 };
    },
    async listVoices() { return null; },
    async healthCheck() { return { ok: true }; },
  };
}

describe("RoutingTtsAdapter", () => {
  it("vozes sem prefixo vão para o principal, tal como vêm", async () => {
    const piper = fake("piper"), eleven = fake("eleven");
    const r = new RoutingTtsAdapter(piper, "pt_PT-tugao", eleven);
    const out = await r.synthesize({ text: "x", voiceId: "CwhRBWXzGAHq8TQ4Fs17" });
    expect(out.wavBuffer.toString()).toBe("piper");
    expect(out.fallback).toBeUndefined();
    expect(piper.calls).toEqual(["CwhRBWXzGAHq8TQ4Fs17"]);
    expect(eleven.calls).toEqual([]);
  });

  it("elevenlabs:<id> vai para a ElevenLabs sem o prefixo", async () => {
    const piper = fake("piper"), eleven = fake("eleven");
    const r = new RoutingTtsAdapter(piper, "pt_PT-tugao", eleven);
    const out = await r.synthesize({ text: "x", voiceId: "elevenlabs:A26KfvFuSKaMzhhYkSlQ" });
    expect(out.wavBuffer.toString()).toBe("eleven");
    expect(eleven.calls).toEqual(["A26KfvFuSKaMzhhYkSlQ"]);
    expect(piper.calls).toEqual([]);
  });

  it("se a ElevenLabs falhar, usa o principal com a voz por omissão e marca fallback", async () => {
    const piper = fake("piper"), eleven = fake("eleven", true);
    const onFallback = vi.fn();
    const r = new RoutingTtsAdapter(piper, "pt_PT-tugao", eleven, onFallback);
    const out = await r.synthesize({ text: "x", voiceId: "elevenlabs:A26KfvFuSKaMzhhYkSlQ" });
    expect(out.wavBuffer.toString()).toBe("piper");
    expect(out.fallback).toBe(true);
    expect(piper.calls).toEqual(["pt_PT-tugao"]);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("sem ElevenLabs configurada, recorre ao principal", async () => {
    const piper = fake("piper");
    const r = new RoutingTtsAdapter(piper, "pt_PT-tugao", null);
    const out = await r.synthesize({ text: "x", voiceId: "elevenlabs:abc" });
    expect(out.fallback).toBe(true);
  });
});
