import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const {
  callKpis,
  agentKpis,
  reasonBreakdown,
  abandonedIds,
  agentRows,
  groupRows,
  delta,
  exportTable,
  tableToCsv,
  typingBreakdown,
  scopeRows,
} = await import("./attendanceReport.service.js");
type CallRow = import("./attendanceReport.service.js").CallRow;
type LegRow = import("./attendanceReport.service.js").LegRow;

/**
 * KPIs de atendimento. Cada bloco prende uma definição de SPRINTS.md (Fase 0):
 * se uma mudar sem querer, o número que o cliente vê muda sem ninguém notar.
 */

const T0 = new Date("2026-10-01T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const call = (id: string, o: Partial<CallRow> = {}): CallRow => ({
  id,
  queuedAt: at(0),
  answeredAt: null,
  endedAt: null,
  groupId: null,
  ...o,
});

const leg = (callId: string, ext: string, o: Partial<LegRow> = {}): LegRow => ({
  callId,
  extensionId: ext,
  extensionNumber: ext.replace("ext_", ""),
  extensionName: null,
  groupId: null,
  ringStartedAt: at(0),
  answeredAt: null,
  endedAt: null,
  outcome: null,
  rejectReason: null,
  rejectNote: null,
  callQueuedAt: at(0),
  ...o,
});

describe("TMA — média(fim − atendimento), só atendidas", () => {
  it("ignora as não atendidas", () => {
    const k = callKpis(
      [
        call("a", { answeredAt: at(10), endedAt: at(70) }), // 60 s
        call("b", { answeredAt: at(5), endedAt: at(125) }), // 120 s
        call("c", { endedAt: at(30) }), // perdida
      ],
      new Set()
    );
    expect(k.tmaSecs).toBe(90);
  });
  it("sem atendidas é null, não 0", () => {
    expect(callKpis([call("c", { endedAt: at(30) })], new Set()).tmaSecs).toBeNull();
  });
});

describe("TME — média(atendimento − início do toque)", () => {
  it("conta a espera desde que começou a tocar, não desde a entrada no IVR", () => {
    const k = callKpis(
      [
        call("a", { queuedAt: at(20), answeredAt: at(26), endedAt: at(60) }), // 6 s
        call("b", { queuedAt: at(0), answeredAt: at(10), endedAt: at(60) }), // 10 s
      ],
      new Set()
    );
    expect(k.tmeSecs).toBe(8);
  });
});

describe("Tempo de resposta do agente — média(atendimento − toque na perna dele)", () => {
  it("só as pernas atendidas pelo agente", () => {
    const k = agentKpis([
      leg("a", "ext_1", { outcome: "ANSWERED", ringStartedAt: at(0), answeredAt: at(4), endedAt: at(30) }),
      leg("b", "ext_1", { outcome: "ANSWERED", ringStartedAt: at(0), answeredAt: at(8), endedAt: at(30) }),
      leg("c", "ext_1", { outcome: "NO_ANSWER", endedAt: at(25) }),
    ]);
    expect(k.responseSecs).toBe(6);
    expect(k.tmaSecs).toBe(24); // (26 + 22) / 2
  });
});

describe("Perdidas e abandonadas", () => {
  it("perdida = tocou e ninguém atendeu; quem desligou no IVR não conta", () => {
    const calls = [
      call("a", { answeredAt: at(5), endedAt: at(60) }),
      call("b", { endedAt: at(25) }), // ninguém atendeu
      call("c", { endedAt: at(8) }), // quem ligou desistiu a tocar
      call("ivr", { queuedAt: null, endedAt: at(10) }), // desligou no menu
    ];
    const legs = [leg("b", "ext_1", { outcome: "NO_ANSWER" }), leg("c", "ext_1", { outcome: "CANCELLED" })];
    const k = callKpis(calls, abandonedIds(legs));
    expect(k).toMatchObject({ total: 3, answered: 1, missed: 2, abandoned: 1 });
    expect(k.answerRate).toBe(33.3);
  });
  it("CANCELLED numa chamada que outro atendeu não é abandono", () => {
    const legs = [leg("a", "ext_1", { outcome: "ANSWERED" }), leg("a", "ext_2", { outcome: "CANCELLED" })];
    expect(abandonedIds(legs).size).toBe(0);
  });
});

describe("Recusadas e taxa de recusa", () => {
  it("recusa só conta o que dependia do agente (não os cancelamentos)", () => {
    const k = agentKpis([
      leg("a", "ext_1", { outcome: "REJECTED" }),
      leg("b", "ext_1", { outcome: "ANSWERED", answeredAt: at(3) }),
      leg("c", "ext_1", { outcome: "CANCELLED" }), // colega atendeu
      leg("d", "ext_1", { outcome: "NO_ANSWER" }),
    ]);
    expect(k).toMatchObject({ offered: 4, rejected: 1, answered: 1, cancelled: 1, noAnswer: 1 });
    expect(k.rejectRate).toBe(33.3);
    expect(k.answerRate).toBe(33.3);
  });
});

describe("Motivos de recusa — contagem e %", () => {
  it("agrupa por motivo, junta os textos livres em Outro e marca o telefone como Sem motivo", () => {
    const rows = reasonBreakdown([
      leg("a", "ext_1", { outcome: "REJECTED", rejectReason: "Em reunião" }),
      leg("b", "ext_1", { outcome: "REJECTED", rejectReason: "Em reunião" }),
      leg("c", "ext_2", { outcome: "REJECTED", rejectNote: "dentista" }),
      leg("d", "ext_2", { outcome: "REJECTED" }),
      leg("e", "ext_2", { outcome: "NO_ANSWER", rejectReason: "Em reunião" }), // não recusou: fora
    ]);
    expect(rows).toEqual([
      { reason: "Em reunião", count: 2, pct: 50 },
      { reason: "Outro", count: 1, pct: 25 },
      { reason: "Sem motivo", count: 1, pct: 25 },
    ]);
  });
});

describe("Comparação com a média do tenant", () => {
  it("delta positivo = acima da média; null sem dados", () => {
    expect(delta(30, 20)).toBe(10);
    expect(delta(null, 20)).toBeNull();
  });
  it("cada agente traz a diferença para o tenant", () => {
    const legs = [
      leg("a", "ext_1", { outcome: "ANSWERED", answeredAt: at(2), endedAt: at(62) }),
      leg("b", "ext_2", { outcome: "ANSWERED", answeredAt: at(6), endedAt: at(126) }),
    ];
    const rows = agentRows(legs, agentKpis(legs));
    const r1 = rows.find((r) => r.extensionId === "ext_1")!;
    expect(r1.vsTenant.responseSecs).toBe(-2); // 2 s vs média 4 s
    expect(r1.vsTenant.tmaSecs).toBe(-30); // 60 s vs média 90 s
  });
  it("por grupo, com chamadas directas à parte", () => {
    const calls = [
      call("a", { groupId: "g1", answeredAt: at(5), endedAt: at(65) }),
      call("b", { groupId: null, endedAt: at(20) }),
    ];
    const rows = groupRows(calls, [], new Map([["g1", "VENDAS"]]), new Set(), callKpis(calls, new Set()));
    expect(rows.map((r) => [r.name, r.total, r.answered])).toEqual([
      ["VENDAS", 1, 1],
      ["Directas", 1, 0],
    ]);
  });
});

describe("Exportação", () => {
  it("CSV com BOM e células com vírgula entre aspas", () => {
    const csv = tableToCsv([["Motivo", "Recusas"], ["Ocupado, volto já", 2]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"Ocupado, volto já",2');
  });
  it("a tabela de motivos sai do relatório", () => {
    const report = { reasons: [{ reason: "Em reunião", count: 3, pct: 100 }] } as never;
    expect(exportTable(report, "reasons")).toEqual([["Motivo", "Recusas", "%"], ["Em reunião", 3, 100]]);
  });
});

describe("Tipificação nos relatórios", () => {
  const NOW = at(10_000);
  const typed = (callId: string, ext: string, cat: string, sub: string | null) =>
    leg(callId, ext, { outcome: "ANSWERED", answeredAt: at(2), endedAt: at(60), typedAt: at(70), category: cat, subcategory: sub });

  it("volume por categoria/subcategoria; não tipificadas à parte; dentro do prazo não conta", () => {
    const rows = typingBreakdown(
      [
        typed("a", "ext_1", "Reclamação", "Facturação"),
        typed("b", "ext_1", "Reclamação", "Facturação"),
        typed("c", "ext_2", "Informação", null),
        leg("d", "ext_2", { outcome: "ANSWERED", answeredAt: at(2), endedAt: at(60), wrapUpEndsAt: at(120) }), // expirou
        leg("e", "ext_2", { outcome: "ANSWERED", answeredAt: at(2), endedAt: at(9_990), wrapUpEndsAt: at(10_050) }), // ainda no prazo
      ],
      NOW
    );
    expect(rows).toEqual([
      { category: "Reclamação", subcategory: "Facturação", count: 2, pct: 50 },
      { category: "Informação", subcategory: null, count: 1, pct: 25 },
      { category: "Não tipificada", subcategory: null, count: 1, pct: 25 },
    ]);
  });

  it("% não tipificadas por agente e pós-chamada sem mexer no TMA", () => {
    const k = agentKpis(
      [
        typed("a", "ext_1", "Informação", null), // pós-chamada 10 s
        leg("b", "ext_1", { outcome: "ANSWERED", answeredAt: at(2), endedAt: at(62), wrapUpEndsAt: at(122) }), // expirou: 60 s
      ],
      NOW
    );
    expect(k).toMatchObject({ typed: 1, untyped: 1, untypedRate: 50, wrapUpSecs: 35, tmaSecs: 59 });
  });
});

describe("Âmbito (agente / supervisor)", () => {
  const calls = [call("c1", { groupId: "g_a" }), call("c2", { groupId: "g_b" }), call("c3", { groupId: "g_b" })];
  const legs = [leg("c1", "ext_1", { groupId: "g_a" }), leg("c2", "ext_2", { groupId: "g_b" }), leg("c3", "ext_1", { groupId: "g_b" })];

  it("agente: só as suas pernas e as chamadas em que tocou", () => {
    const r = scopeRows(calls, legs, { extensionIds: ["ext_1"], groupIds: [] });
    expect(r.legs.map((l) => l.callId)).toEqual(["c1", "c3"]);
    expect(r.calls.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("supervisor: as do grupo dele, mesmo de agentes de fora, e as dos agentes dele", () => {
    const r = scopeRows(calls, legs, { extensionIds: ["ext_1"], groupIds: ["g_b"] });
    expect(r.calls.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(scopeRows(calls, legs, { extensionIds: [], groupIds: ["g_a"] }).calls.map((c) => c.id)).toEqual(["c1"]);
  });
});
