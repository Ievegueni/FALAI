import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { attendanceWorkbook } from "./excelExport.service.js";

/** Excel dos relatórios: números como números (não texto), com o formato certo. */
describe("Excel formatado", () => {
  it("folha por agente: cabeçalho, filtros, % e durações como números", async () => {
    const report = {
      from: "2026-09-03T00:00:00Z",
      to: "2026-10-02T23:59:59Z",
      byAgent: [{ number: "1000", name: "Ana Costa", offered: 10, answered: 9, rejected: 1, noAnswer: 0, busy: 0, answerRate: 90, rejectRate: 10, tmaSecs: 192, tmeSecs: 5, responseSecs: 4, typed: 8, untypedRate: 11.1, wrapUpSecs: 30 }],
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
