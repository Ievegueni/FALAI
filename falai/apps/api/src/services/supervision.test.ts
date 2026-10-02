import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const { SupervisionManager, SupervisionError } = await import("./supervision.service.js");
const { inScope, agentState } = await import("../routes/tenant/supervision.js");

/**
 * Supervisão sobre o ARI. Um ARI falso guarda o estado das bridges para os
 * testes verem quem ouve quem — e que nada fica para trás.
 */

function fakeAri() {
  const bridges = new Map<string, Set<string>>([["conv", new Set(["trunk", "agent"])]]);
  const live = new Set<string>(["trunk", "agent"]);
  const snoops = new Map<string, { of: string; whisper: string }>();
  let ring: { onAnswer: (id: string) => void; onAllFailed: () => void } | null = null;
  let seq = 0;
  const ari = {
    createBridge: vi.fn(async (name?: string) => {
      const id = `br_${name ?? ++seq}`;
      bridges.set(id, new Set());
      return { id };
    }),
    destroyBridge: vi.fn(async (id: string) => void bridges.delete(id)),
    addChannelToBridge: vi.fn(async (b: string, c: string) => void bridges.get(b)!.add(c)),
    removeChannelFromBridge: vi.fn(async (b: string, c: string) => void bridges.get(b)?.delete(c)),
    snoopChannel: vi.fn(async (of: string, o: { whisper: string }) => {
      const id = `snoop_${++seq}`;
      snoops.set(id, { of, whisper: o.whisper });
      live.add(id);
      return { id };
    }),
    originateToPjsipEndpoint: vi.fn(async (ep: string) => {
      live.add(`ch_${ep}`);
      return { id: `ch_${ep}` };
    }),
    registerRingGroup: vi.fn((_ids: string[], onAnswer: (id: string) => void, onAllFailed: () => void) => {
      ring = { onAnswer, onAllFailed };
    }),
    hangup: vi.fn(async (id: string) => {
      live.delete(id);
      for (const set of bridges.values()) set.delete(id);
    }),
    listBridges: vi.fn(async () => [...bridges.entries()].map(([id, ch]) => ({ id, name: id.replace(/^br_/, ""), channels: [...ch] }))),
  };
  return { ari, bridges, live, snoops, answer: (id: string) => ring!.onAnswer(id), fail: () => ring!.onAllFailed() };
}

const CALL = {
  tenantId: "tnt_1",
  callId: "call_1",
  callerChannelId: "trunk",
  agentChannelId: "agent",
  bridgeId: "conv",
  groupId: "grp_vendas",
  agentExtensionId: "ext_agente",
  answeredAt: new Date(),
};
const flush = () => new Promise((r) => setTimeout(r, 0));

let f: ReturnType<typeof fakeAri>;
let audit: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;
let m: InstanceType<typeof SupervisionManager>;

beforeEach(() => {
  f = fakeAri();
  audit = vi.fn(async () => {});
  notify = vi.fn();
  m = new SupervisionManager({ asterisk: f.ari as never, audit, notifyAgent: notify, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
});

async function startAndAnswer(mode: "LISTEN" | "WHISPER" | "BARGE") {
  const s = await m.start({ call: CALL, supervisorId: "sup_1", supervisorExtensionId: "ext_sup", supervisorEndpoints: ["web_sup", "hard_sup"], mode });
  f.answer("ch_web_sup");
  await flush();
  return s;
}
const supBridge = (id: string) => f.bridges.get(`br_supervise-${id}`)!;

describe("modos", () => {
  it("Escuta: snoop sem sussurro na bridge do supervisor; a conversa fica igual", async () => {
    const s = await startAndAnswer("LISTEN");
    const snoop = [...f.snoops.entries()][0]!;
    expect(snoop[1]).toEqual({ of: "agent", whisper: "none" });
    expect([...supBridge(s.id)]).toEqual(["ch_web_sup", snoop[0]]);
    expect([...f.bridges.get("conv")!]).toEqual(["trunk", "agent"]);
    expect(f.live.has("ch_hard_sup")).toBe(false); // a outra perna do supervisor foi desligada
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: "START", mode: "LISTEN", supervisorId: "sup_1", callId: "call_1" }));
  });

  it("Sussurro: o áudio do supervisor vai só para o agente (whisper=out)", async () => {
    await startAndAnswer("WHISPER");
    expect([...f.snoops.values()][0]).toEqual({ of: "agent", whisper: "out" });
    expect(notify).toHaveBeenCalledWith("tnt_1", "ext_agente", "WHISPER");
  });

  it("Intervenção: o supervisor entra na bridge da conversa, sem snoop", async () => {
    const s = await startAndAnswer("BARGE");
    expect([...f.bridges.get("conv")!]).toEqual(["trunk", "agent", "ch_web_sup"]);
    expect(supBridge(s.id).size).toBe(0);
    expect([...f.live].some((c) => c.startsWith("snoop_"))).toBe(false);
  });
});

describe("troca de modo sem desligar", () => {
  it("Escuta → Sussurro → Intervenção → Escuta, sempre com o mesmo canal do supervisor", async () => {
    const s = await startAndAnswer("LISTEN");
    await m.setMode(s.id, "WHISPER");
    const snoops = [...f.snoops.keys()].filter((id) => f.live.has(id));
    expect(snoops).toHaveLength(1); // o snoop velho foi largado
    expect(f.snoops.get(snoops[0]!)!.whisper).toBe("out");

    await m.setMode(s.id, "BARGE");
    expect(f.bridges.get("conv")!.has("ch_web_sup")).toBe(true);
    expect([...f.live].some((c) => c.startsWith("snoop_"))).toBe(false);

    await m.setMode(s.id, "LISTEN");
    expect(f.bridges.get("conv")!.has("ch_web_sup")).toBe(false);
    expect(supBridge(s.id).has("ch_web_sup")).toBe(true);
    expect(f.live.has("ch_web_sup")).toBe(true);
    expect(audit.mock.calls.map((c) => [c[0].type, c[0].mode])).toEqual([
      ["START", "LISTEN"],
      ["MODE", "WHISPER"],
      ["MODE", "BARGE"],
      ["MODE", "LISTEN"],
    ]);
  });
});

describe("fim", () => {
  it("terminar a supervisão limpa tudo e a conversa continua", async () => {
    const s = await startAndAnswer("BARGE");
    await m.end(s.id, "SUPERVISOR");
    expect([...f.bridges.get("conv")!]).toEqual(["trunk", "agent"]);
    expect(f.bridges.has(`br_supervise-${s.id}`)).toBe(false);
    expect([...f.live].sort()).toEqual(["agent", "trunk"]);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "END", endReason: "SUPERVISOR" }));
    expect(notify).toHaveBeenLastCalledWith("tnt_1", "ext_agente", null);
  });

  it.each([["trunk"], ["agent"]])("se %s desligar, a supervisão termina sozinha", async (who) => {
    const s = await startAndAnswer("LISTEN");
    await m.onCallEvent({ type: "CALL_ENDED", providerCallId: who, endedAt: new Date(), durationSecs: 1, hangupCause: "16" });
    expect(m.get(s.id)).toBeUndefined();
    expect(f.live.has("ch_web_sup")).toBe(false);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "END", endReason: "CALL_ENDED" }));
  });

  it("o supervisor desligar o telefone termina a supervisão", async () => {
    const s = await startAndAnswer("LISTEN");
    await m.onCallEvent({ type: "CALL_FAILED", providerCallId: "ch_web_sup", reason: "16" });
    expect(m.get(s.id)).toBeUndefined();
  });

  it("supervisor que não atende: limpa sem registo de início", async () => {
    const s = await m.start({ call: CALL, supervisorId: "sup_1", supervisorExtensionId: "ext_sup", supervisorEndpoints: ["web_sup"], mode: "LISTEN" });
    f.fail();
    await flush();
    expect(m.get(s.id)).toBeUndefined();
    expect(f.bridges.has(`br_supervise-${s.id}`)).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("varre bridges de supervisão órfãs de um reinício, sem tocar na conversa", async () => {
    f.bridges.set("br_supervise-velha", new Set(["snoop_x"]));
    expect(await m.sweepOrphans()).toBe(1);
    expect(f.bridges.has("br_supervise-velha")).toBe(false);
    expect(f.bridges.has("conv")).toBe(true);
  });
});

describe("regras e permissões", () => {
  it("não pode supervisionar a própria chamada", async () => {
    await expect(
      m.start({ call: CALL, supervisorId: "u", supervisorExtensionId: "ext_agente", supervisorEndpoints: ["x"], mode: "LISTEN" })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("só um supervisor por chamada", async () => {
    await startAndAnswer("LISTEN");
    const second = m.start({ call: CALL, supervisorId: "sup_2", supervisorExtensionId: "ext_sup2", supervisorEndpoints: ["y"], mode: "LISTEN" });
    await expect(second).rejects.toBeInstanceOf(SupervisionError);
    await expect(second).rejects.toMatchObject({ status: 409 });
  });

  it("supervisor só vê chamadas dos seus grupos (ou dos agentes desses grupos); admin vê todas", () => {
    const sup = { all: false as const, groupIds: new Set(["grp_suporte"]), extensionIds: new Set(["ext_x"]) };
    expect(inScope(sup, { groupId: "grp_vendas", agentExtensionId: "ext_agente" })).toBe(false);
    expect(inScope(sup, { groupId: "grp_suporte", agentExtensionId: "ext_agente" })).toBe(true);
    expect(inScope(sup, { groupId: null, agentExtensionId: "ext_x" })).toBe(true);
    expect(inScope({ all: true }, { groupId: "grp_vendas", agentExtensionId: "ext_agente" })).toBe(true);
  });

  it("estado do agente: em chamada > a tocar > pós-chamada > pausa > disponível/offline", () => {
    const t = new Date();
    const base = { inCallSince: null, ringingSince: null, wrapUpSince: null, pausedAt: null, online: true };
    expect(agentState({ ...base, inCallSince: t, pausedAt: t })).toEqual({ state: "IN_CALL", since: t });
    expect(agentState({ ...base, wrapUpSince: t, pausedAt: t }).state).toBe("WRAP_UP");
    expect(agentState({ ...base, pausedAt: t }).state).toBe("PAUSED");
    expect(agentState(base)).toEqual({ state: "AVAILABLE", since: null });
    expect(agentState({ ...base, online: false }).state).toBe("OFFLINE");
  });
});
