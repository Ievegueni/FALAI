import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";

/**
 * Análise dos relatórios com IA (melhoria 6): resumo agregado enviado à IA
 * (sem dados pessoais, comparações pré-calculadas), validação do JSON, cache,
 * limite diário, erros da API e exportação.
 */

const db = {
  reportAnalysis: {
    findFirst: vi.fn(async (): Promise<any> => null),
    count: vi.fn(async () => 0),
    create: vi.fn(async ({ data }: any) => ({ id: "ra_1", createdAt: new Date("2026-10-02T10:00:00Z"), ...data })),
  },
};
vi.mock("@falai/db", () => ({ prisma: db }));

const svc = await import("./reportAnalysis.service.js");
const { addAnalysisSheet } = await import("./excelExport.service.js");

const calls = (o: Partial<Record<string, number | null>> = {}) => ({ total: 100, answered: 80, missed: 20, abandoned: 5, answerRate: 80, tmaSecs: 120, tmeSecs: 20, ...o });
const agentK = (o: Partial<Record<string, number | null>> = {}) => ({
  offered: 120, answered: 80, rejected: 10, noAnswer: 20, busy: 0, failed: 0, cancelled: 10,
  answerRate: 66.7, rejectRate: 8.3, tmaSecs: 120, tmeSecs: 20, responseSecs: 8, typed: 70, untyped: 10, untypedRate: 12.5, wrapUpSecs: 30, ...o,
});
const agent = (id: string, number: string, name: string, answerRate: number, vsAr: number, vsRr = 0) => ({
  extensionId: id, number, name, ...agentK({ answerRate }),
  vsTenant: { answerRate: vsAr, rejectRate: vsRr, tmaSecs: 0, responseSecs: 0 },
});
const report = (o: Partial<any> = {}) => ({
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-30T23:59:59.999Z",
  limited: false,
  tenant: { calls: calls(), agents: agentK() },
  selection: { calls: calls(), agents: agentK() },
  reasons: [{ reason: "Em pausa", count: 6, pct: 60 }, { reason: "Outro", count: 4, pct: 40 }],
  typing: [{ category: "Reclamação", subcategory: "Facturação", count: 20, pct: 40 }],
  byDay: [
    { date: "2026-09-01", tmaSecs: 100, tmeSecs: 15, responseSecs: 8, wrapUpSecs: 30 },
    { date: "2026-09-02", tmaSecs: 100, tmeSecs: 15, responseSecs: 8, wrapUpSecs: 30 },
    { date: "2026-09-03", tmaSecs: 100, tmeSecs: 60, responseSecs: 8, wrapUpSecs: 30 },
  ],
  byAgent: [agent("e1", "1001", "Ana Costa", 80, 13.3), agent("e2", "1002", "Rui Lopes", 50, -16.7, 6), agent("e3", "1003", "Edna", 66, -0.7)],
  byGroup: [{ groupId: "g1", name: "VENDAS", ...calls({ answerRate: 90 }), rejected: 2, vsTenant: { answerRate: 10, tmaSecs: 0, tmeSecs: 0 } }],
  ...o,
});
const previous = report({
  selection: { calls: calls({ total: 80, missed: 10 }), agents: agentK({ rejected: 4 }) },
  typing: [{ category: "Reclamação", subcategory: "Facturação", count: 10, pct: 30 }],
  reasons: [{ reason: "Em pausa", count: 2, pct: 50 }],
});
const filters = { from: "2026-09-01", to: "2026-09-30" };
const opts = { scope: { agent: null, group: null, typing: null }, agentNames: false };

const validResult = {
  headline: "Atendimento estável.",
  summary: "Foram recebidas 100 chamadas.",
  comparison: "Mais 25% que no período anterior.",
  anomalies: [{ title: "TME alto", detail: "Dia 3.", severity: "warning" }],
  agents: { above: [{ who: "Ext. 1001", why: "80%" }], below: [] },
  groups: { above: [], below: [] },
  typingTrends: [{ label: "Reclamação › Facturação", detail: "10 → 20" }],
  recommendations: [{ title: "Reforçar o turno", detail: "Nos dias de pico." }],
};

describe("resumo enviado à IA", () => {
  const input = svc.prepareAnalysisInput(report() as never, previous as never, filters, opts);
  const json = JSON.stringify(input);

  it("só agregados: sem nomes de agentes por omissão, sem telefones", () => {
    expect(json).not.toContain("Ana Costa");
    expect(json).not.toMatch(/9\d{8}/);
    expect(input.agents.map((a) => a.ref)).toEqual(["Ext. 1001", "Ext. 1002", "Ext. 1003"]);
  });

  it("com permissão do cliente, os agentes vão pelo nome", () => {
    const named = svc.prepareAnalysisInput(report() as never, previous as never, filters, { ...opts, agentNames: true });
    expect(named.agents[0]!.ref).toBe("Ana Costa (ext. 1001)");
  });

  it("comparações pré-calculadas", () => {
    expect((input.calls as any).total).toEqual({ current: 100, previous: 80, deltaPct: 25 });
    expect((input.calls as any).missed.deltaPct).toBe(100);
    expect(input.rejectReasons[0]).toMatchObject({ reason: "Em pausa", previousCount: 2, deltaPct: 200 });
    expect(input.typings[0]).toMatchObject({ previousCount: 10, count: 20, trend: "up" });
  });

  it("agentes e grupos acima/abaixo da média", () => {
    expect(input.agents.map((a) => a.position)).toEqual(["above", "below", "average"]);
    expect(input.groups[0]!.position).toBe("above");
  });

  it("sinais detectados no backend", () => {
    expect(input.signals.some((s) => s.startsWith("TME alto em 2026-09-03"))).toBe(true);
    expect(input.signals.some((s) => s.includes("Recusas a subir"))).toBe(true);
    expect(input.signals.some((s) => s.includes('Motivo de recusa dominante: "Em pausa"'))).toBe(true);
    expect(input.signals.some((s) => s.includes("Tipificação a crescer"))).toBe(true);
    expect(input.signals.some((s) => s.includes("Não atendidas a subir"))).toBe(true);
  });

  it("supervisor: só os agentes dos grupos dele", () => {
    const sup = svc.prepareAnalysisInput(report() as never, previous as never, { ...filters, groupId: "g1" }, {
      ...opts, scope: { agent: null, group: "VENDAS", typing: null }, allowedExtensionIds: new Set(["e2"]),
    });
    expect(sup.agents.map((a) => a.ref)).toEqual(["Ext. 1002"]);
    expect(sup.tenantTotals).toBeNull();
  });

  it("o hash muda com os dados e não com a ordem de chamada", () => {
    const again = svc.prepareAnalysisInput(report() as never, previous as never, filters, opts);
    expect(svc.dataHash(again)).toBe(svc.dataHash(input));
    const other = svc.prepareAnalysisInput(report({ selection: { calls: calls({ total: 101 }), agents: agentK() } }) as never, previous as never, filters, opts);
    expect(svc.dataHash(other)).not.toBe(svc.dataHash(input));
    expect(svc.filtersKey(filters)).not.toBe(svc.filtersKey({ ...filters, groupId: "g1" }));
  });
});

describe("validação do JSON da IA", () => {
  it("aceita a estrutura completa", () => {
    expect(svc.analysisResultSchema.safeParse(validResult).success).toBe(true);
  });
  it("recusa campos em falta ou severidade inválida", () => {
    const { recommendations: _r, ...semRecs } = validResult;
    expect(svc.analysisResultSchema.safeParse(semRecs).success).toBe(false);
    expect(svc.analysisResultSchema.safeParse({ ...validResult, anomalies: [{ title: "x", detail: "y", severity: "grave" }] }).success).toBe(false);
  });
});

describe("runAnalysis: cache, limite, custo e erros", () => {
  const input = svc.prepareAnalysisInput(report() as never, previous as never, filters, opts);
  const llm = { structured: vi.fn(async (_p: any): Promise<any> => null) };
  const params = { tenantId: "t1", userId: "u1", filters, input, llm: llm as never, model: "claude-sonnet-4-6", dailyLimit: 3 };

  beforeEach(() => {
    vi.clearAllMocks();
    db.reportAnalysis.findFirst.mockResolvedValue(null);
    db.reportAnalysis.count.mockResolvedValue(0);
  });

  it("chama a IA, valida, regista tokens e custo", async () => {
    llm.structured.mockResolvedValue({ input: validResult, inputTokens: 2000, outputTokens: 800, durationMs: 4000, model: "claude-sonnet-4-6" });
    const r = await svc.runAnalysis(params);
    expect(r.cached).toBe(false);
    expect(r.analysis.result.headline).toBe("Atendimento estável.");
    const data = (db.reportAnalysis.create.mock.calls[0] as any)[0].data;
    expect(data).toMatchObject({ tenantId: "t1", inputTokens: 2000, outputTokens: 800, costMicroUsd: 2000 * 3 + 800 * 15, promptVersion: svc.PROMPT_VERSION });
    // o pedido leva só o resumo agregado e o prompt versionado
    const call = llm.structured.mock.calls[0]![0];
    expect(call.system).toBe(svc.SYSTEM_PROMPT);
    expect(call.user).toContain(JSON.stringify(input));
  });

  it("mesmos filtros e mesmos dados → cache, sem IA nem limite", async () => {
    db.reportAnalysis.findFirst.mockResolvedValue({ id: "ra_old", result: validResult, createdAt: new Date(), model: "claude-sonnet-4-6" });
    db.reportAnalysis.count.mockResolvedValue(99);
    const r = await svc.runAnalysis(params);
    expect(r.cached).toBe(true);
    expect(llm.structured).not.toHaveBeenCalled();
    expect((db.reportAnalysis.findFirst.mock.calls[0] as any)[0]).toMatchObject({
      where: { tenantId: "t1", filtersKey: svc.filtersKey(filters), dataHash: svc.dataHash(input), model: { not: "stub" } },
    });
  });

  it("limite diário atingido → 429 sem chamar a IA", async () => {
    db.reportAnalysis.count.mockResolvedValue(3);
    await expect(svc.runAnalysis(params)).rejects.toMatchObject({ status: 429 });
    expect(llm.structured).not.toHaveBeenCalled();
  });

  it("limite 0 (desligado no backoffice) → 403", async () => {
    await expect(svc.runAnalysis({ ...params, dailyLimit: 0 })).rejects.toMatchObject({ status: 403 });
    expect(llm.structured).not.toHaveBeenCalled();
  });

  it("timeout da API → mensagem clara e erro registado", async () => {
    llm.structured.mockRejectedValue(new Error("Request timed out."));
    await expect(svc.runAnalysis(params)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("demorou demasiado") });
    expect((db.reportAnalysis.create.mock.calls[0] as any)[0].data.error).toContain("timed out");
  });

  it("JSON inválido da IA → 502 e não fica como análise válida", async () => {
    llm.structured.mockResolvedValue({ input: { headline: "só isto" }, inputTokens: 10, outputTokens: 5, durationMs: 1, model: "claude-sonnet-4-6" });
    await expect(svc.runAnalysis(params)).rejects.toMatchObject({ status: 502 });
    expect((db.reportAnalysis.create.mock.calls[0] as any)[0].data.error).toMatch(/JSON inválido/);
  });

  it("modo de teste (sem chave): análise dos sinais, sem tokens", async () => {
    llm.structured.mockResolvedValue(null);
    const r = await svc.runAnalysis(params);
    expect(r.analysis.model).toBe("stub");
    expect(svc.analysisResultSchema.safeParse(r.analysis.result).success).toBe(true);
    expect(r.analysis.result.anomalies.length).toBeGreaterThan(0);
  });
});

describe("exportação", () => {
  it("secções na ordem do ecrã, sem as vazias", () => {
    const s = svc.analysisSections(validResult as never);
    expect(s.map((x) => x.title)).toEqual([
      "Conclusão", "Leitura do resumo", "Comparação com o período anterior", "Anomalias",
      "Agentes acima da média", "Tipificações em crescimento", "Recomendações",
    ]);
    expect(s.find((x) => x.title === "Anomalias")!.lines[0]).toBe("[Atenção] TME alto: Dia 3.");
  });

  it("folha \"Análise IA\" no Excel", async () => {
    const wb = new ExcelJS.Workbook();
    addAnalysisSheet(wb, { result: validResult as never, createdAt: new Date("2026-10-02T10:00:00Z") });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load((await wb.xlsx.writeBuffer()) as never);
    const ws = back.getWorksheet("Análise IA")!;
    const text = ws.getColumn(1).values.filter(Boolean).map(String);
    expect(text[0]).toBe("Análise com IA");
    expect(text).toContain("Recomendações");
    expect(text).toContain("1. Reforçar o turno — Nos dias de pico.");
  });
});
