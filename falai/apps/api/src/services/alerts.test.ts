import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("@falai/providers", () => ({ extensionEndpointId: (s: string) => s, extensionWebEndpointId: (s: string) => s }));
vi.mock("./inboundCallRouter.service.js", () => ({ activeInboundCalls: () => [] }));
vi.mock("./webhookEmitter.service.js", () => ({ emitWebhookAsync: () => undefined }));
vi.mock("./features.js", () => ({ tenantHasFeature: async () => true }));
const { liveBreaches, dailyBreaches, diffAlerts, parseTargets } = await import("./alerts.service.js");
const { callKpis } = await import("./attendanceReport.service.js");

/** Alertas operacionais: quando abrem, quando fecham, e o SLA. */

const now = new Date("2026-10-06T10:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const targets = (o: Record<string, unknown> = {}) => parseTargets(o);

describe("metas", () => {
  it("sem nada guardado: SLA a 21 s e nenhum alerta ligado", () => {
    expect(targets()).toEqual({ slaThresholdSecs: 21, slaTargetPct: null, maxWaitSecs: null, maxHandleSecs: null, minAvailableAgents: null, maxAbandonPct: null, maxTmaSecs: null });
    expect(parseTargets("lixo")).toEqual(targets());
  });
});

describe("alertas ao vivo", () => {
  const snap = {
    now,
    waiting: [{ id: "c1", groupId: "g1", queuedAt: ago(90) }, { id: "c2", groupId: "g1", queuedAt: ago(20) }],
    inCall: [{ id: "c3", groupId: null, answeredAt: ago(1300) }],
    groups: [
      { id: "g1", online: 2, available: 0, waiting: 2 },
      { id: "g2", online: 0, available: 0, waiting: 0 }, // fora de horas: sem alerta
    ],
  };

  it("espera, atendimento longo e grupo sem agentes — só o que passou o limite", () => {
    const b = liveBreaches(snap, targets({ maxWaitSecs: 60, maxHandleSecs: 1200, minAvailableAgents: 1 }));
    expect(b).toEqual([
      { type: "LONG_WAIT", ref: "c1", groupId: "g1", value: 90, threshold: 60 },
      { type: "LONG_HANDLE", ref: "c3", groupId: null, value: 1300, threshold: 1200 },
      { type: "NO_AGENTS", ref: "g1", groupId: "g1", value: 0, threshold: 1 },
    ]);
  });

  it("limites desligados não geram nada", () => {
    expect(liveBreaches(snap, targets())).toEqual([]);
  });
});

describe("desvios do dia", () => {
  const k = { answered: 8, missed: 4, abandoned: 3, slaPct: 60, tmaSecs: 400 };

  it("SLA abaixo da meta, abandono e TMA acima", () => {
    const b = dailyBreaches(k, "2026-10-06", targets({ slaTargetPct: 80, maxAbandonPct: 20, maxTmaSecs: 300 }));
    expect(b.map((x) => [x.type, x.value])).toEqual([["SLA_BELOW", 60], ["ABANDON_ABOVE", 25], ["TMA_ABOVE", 400]]);
    expect(b.every((x) => x.ref === "2026-10-06")).toBe(true);
  });

  it("com menos de 10 chamadas terminadas não alarma", () => {
    expect(dailyBreaches({ ...k, answered: 5, missed: 4 }, "d", targets({ slaTargetPct: 99 }))).toEqual([]);
  });
});

describe("abrir e fechar", () => {
  const open = [
    { id: "a1", type: "LONG_WAIT" as const, ref: "c1" },
    { id: "a2", type: "LONG_WAIT" as const, ref: "c9" },
    { id: "a3", type: "SLA_BELOW" as const, ref: "2026-10-06" },
  ];
  const breach = (type: "LONG_WAIT" | "NO_AGENTS", ref: string) => ({ type, ref, groupId: null, value: 1, threshold: 0 });

  it("abre o novo, mantém o que continua, fecha o que passou", () => {
    const r = diffAlerts(open, [breach("LONG_WAIT", "c1"), breach("NO_AGENTS", "g1")], new Set(["LONG_WAIT", "NO_AGENTS"] as const));
    expect(r.toOpen.map((b) => b.ref)).toEqual(["g1"]);
    expect(r.toClose).toEqual(["a2"]); // o do SLA não foi avaliado nesta volta: fica aberto
  });
});

describe("SLA nos KPIs", () => {
  const T0 = new Date("2026-10-01T10:00:00Z");
  const at = (s: number) => new Date(T0.getTime() + s * 1000);
  const c = (id: string, ans: number | null, end = 100) => ({ id, queuedAt: at(0), answeredAt: ans === null ? null : at(ans), endedAt: at(end), groupId: null });

  it("% das terminadas atendidas abaixo do limiar (perdidas contam no total)", () => {
    const calls = [c("a", 5), c("b", 20), c("d", 30), c("e", null)];
    expect(callKpis(calls, new Set()).slaPct).toBe(50); // 2 de 4 abaixo de 21 s
    expect(callKpis(calls, new Set(), 40).slaPct).toBe(75);
  });
});
