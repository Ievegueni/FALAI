import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { attendanceWorkbook, csatWorkbook } from "./excelExport.service.js";

/** Excel dos relatórios: números como números (não texto), com o formato certo. */
describe("Excel formatado", () => {
  it("folha por agente: cabeçalho, filtros, % e durações como números", async () => {
    const report = {
      from: "2026-09-03T00:00:00Z",
      to: "2026-10-02T23:59:59Z",
      byAgent: [{ number: "1000", name: "Ana Costa", offered: 10, answered: 9, rejected: 1, noAnswer: 0, busy: 0, answerRate: 90, rejectRate: 10, tmaSecs: 192, tmeSecs: 5, responseSecs: 4, typed: 8, untypedRate: 11.1, wrapUpSecs: 30, vsTenant: { answerRate: 2.5, rejectRate: null, tmaSecs: -10, responseSecs: 1 } }],
    } as never;
    const buf = await attendanceWorkbook(report, "agents", "Demo Company");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const ws = wb.getWorksheet("Por agente")!;
    expect(ws.getCell("A1").value).toBe("Atendimento por agente");
    expect(ws.getCell("A4").value).toBe("Extensão");
    expect(ws.getCell("A4").font.bold).toBe(true);
    expect(ws.getCell("H5").value).toBe(0.9); // 90% guardado como 0,9
    expect(ws.getCell("H5").numFmt).toBe("0.0%");
    // Fracção de dia no ficheiro; ao ler, o exceljs devolve-a como hora (base 30/12/1899).
    expect((ws.getCell("J5").value as Date).toISOString()).toBe("1899-12-30T00:03:12.000Z");
    expect(ws.getCell("J5").numFmt).toBe("[h]:mm:ss");
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.getCell("P5").value).toBe(2.5); // Δ % atendimento em p.p.
  });

  it("separador Atendimento: indicadores, por dia (SLA vs meta), por hora e mapa de horas", async () => {
    const kpis = { total: 12, answered: 9, missed: 3, abandoned: 2, shortAbandoned: 1, answerRate: 75, abandonRate: 9.1, tmaSecs: 120, tmeSecs: 15, asaP90Secs: 40, maxWaitSecs: 90, slaMet: 7, slaPct: 63.6 };
    const agents = { offered: 12, answered: 9, rejected: 1, noAnswer: 2, busy: 0, failed: 0, cancelled: 0, answerRate: 75, rejectRate: 8.3, tmaSecs: 120, tmeSecs: 15, responseSecs: 6, typed: 9, untyped: 0, untypedRate: 0, wrapUpSecs: 20 };
    const period = { total: 12, answered: 9, missed: 3, abandoned: 2, shortAbandoned: 1, answerRate: 75, slaPct: 63.6, tmaSecs: 120, tmeSecs: 15, asaP90Secs: 40, maxWaitSecs: 90 };
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    grid[0]![9] = 12;
    const report = {
      from: "2026-09-03T00:00:00Z", to: "2026-10-02T23:59:59Z", limited: false,
      tenant: { calls: kpis, agents }, selection: { calls: kpis, agents },
      byDay: [{ date: "2026-10-01", ...period, responseSecs: 6, wrapUpSecs: 20 }],
      byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, ...period })),
      byWeekdayHour: grid, slaSecs: 21, slaTargetPct: 80, shortAbandonSecs: 5,
      csat: { responses: 4, avg: 4.5, satisfiedPct: 100, distribution: { 1: 0, 2: 0, 3: 0, 4: 2, 5: 2 } },
    } as never;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await attendanceWorkbook(report, "attendance", "Demo")) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Indicadores", "Por dia", "Por hora", "Mapa de horas"]);
    const ind = wb.getWorksheet("Indicadores")!;
    const slaRow = [...Array(30).keys()].map((i) => ind.getRow(5 + i)).find((r) => String(r.getCell(1).value).startsWith("SLA"))!;
    expect(slaRow.getCell(2).value).toBeCloseTo(0.636);
    expect(slaRow.getCell(2).font.color?.argb).toBe("FFD03B3B"); // abaixo da meta de 80 %
    const day = wb.getWorksheet("Por dia")!;
    expect(day.getCell("I5").value).toBe(0.8); // meta ao lado do SLA
    expect(wb.getWorksheet("Por hora")!.getCell("A14").value).toBe("09:00");
    expect(wb.getWorksheet("Mapa de horas")!.getCell("K5").value).toBe(12); // segunda, 09 h
  });

  it("separador Chamadas: a lista inteira com as extensões", async () => {
    const report = { from: "2026-09-03T00:00:00Z", to: "2026-10-02T23:59:59Z" } as never;
    const calls = [{ id: "c1", from: "923000000", to: "1000", contactId: null, contactName: "Rui", startedAt: new Date("2026-10-01T09:00:00Z"), group: "Vendas", answered: true, waitSecs: 8, talkSecs: 60,
      legs: [{ extension: "1001", outcome: "REJECTED", responseSecs: null, reason: "Em reunião", typing: null, typingNote: null }, { extension: "1002", outcome: "ANSWERED", responseSecs: 3, reason: null, typing: "Facturação", typingNote: "ok" }] }];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await attendanceWorkbook(report, "calls", "Demo", null, { calls: calls as never, filters: "Grupo Vendas" })) as never);
    const ws = wb.getWorksheet("Chamadas")!;
    expect(String(ws.getCell("A2").value)).toContain("Grupo Vendas");
    expect(ws.getCell("H5").value).toBe("1002");
    expect(ws.getCell("K5").value).toBe("1001 Recusou (Em reunião) · 1002 Atendeu");
  });
});

describe("gráficos nativos no Excel", () => {
  it("cada folha com gráfico leva um desenho e um gráfico ligado às células", async () => {
    const JSZip = (await import("jszip")).default;
    const report = {
      from: "2026-09-03T00:00:00Z",
      to: "2026-10-02T23:59:59Z",
      reasons: [{ reason: "Em reunião", count: 3, pct: 60 }, { reason: "Outro", count: 2, pct: 40 }],
    } as never;
    const zip = await JSZip.loadAsync(await attendanceWorkbook(report, "reasons", "Demo Company"));
    const chart = await zip.file("xl/charts/chart1.xml")!.async("string");
    expect(chart).toContain("<c:barChart>");
    expect(chart).toContain('<c:showVal val="1"/>'); // números nas barras
    expect(chart).toContain("<c:f>'Motivos de recusa'!$B$5:$B$6</c:f>");
    expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('<drawing r:id="rIdFalaiDrawing"/>');
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain("/xl/charts/chart1.xml");
  });
});

describe("Excel da satisfação", () => {
  it("resumo, por canal/agente/grupo/dia e as negativas com o comentário", async () => {
    const sum = (avg: number) => ({ responses: 2, avg, satisfiedPct: 50, distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 1 } });
    const report = {
      from: "2026-10-01T00:00:00Z", to: "2026-10-02T23:59:59Z", overall: sum(3), asked: 4,
      byChannel: [{ key: "SMS", name: "SMS", ...sum(3) }], byAgent: [{ key: "u1", name: "Ana", ...sum(3) }], byGroup: [],
      byDay: [{ key: "2026-10-01", name: "2026-10-01", ...sum(3) }, { key: "2026-10-02", name: "2026-10-02", ...sum(3) }],
      negatives: [{ id: "r1", at: new Date("2026-10-01T10:00:00Z"), score: 1, channel: "SMS", agent: "Ana", group: null, contact: { id: "c", name: "Rui", phone: "923000000" },
        comment: "Esperei muito", callId: null, conversationId: null, ticketId: null, reviewedAt: null, reviewedBy: null, reviewNote: null }],
    } as never;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await csatWorkbook(report, "Demo")) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Resumo", "Por canal", "Por agente", "Por grupo", "Por dia", "Negativas"]);
    expect(wb.getWorksheet("Resumo")!.getCell("B9").value).toBe(0.5); // taxa de resposta 2/4
    const neg = wb.getWorksheet("Negativas")!;
    expect(neg.getCell("H5").value).toBe("Esperei muito");
    expect(neg.getCell("I5").value).toBe("Por tratar");
  });
});
