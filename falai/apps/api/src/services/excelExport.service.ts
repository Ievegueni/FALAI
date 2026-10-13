/**
 * Exportação dos relatórios para Excel (.xlsx) já formatado: título e período
 * no topo, cabeçalho destacado com filtros, primeira linha fixa, linhas
 * alternadas, larguras certas e cada coluna com o seu formato (números,
 * percentagens, durações em h:mm:ss, datas, kwanzas). As durações e as %
 * ficam como números, não texto — dá para somar e ordenar no Excel.
 *
 * Usa exceljs: a biblioteca xlsx (SheetJS) gratuita não escreve estilos.
 */
import ExcelJS from "exceljs";
import { analysisSections, type AnalysisResult } from "./reportAnalysis.service.js";
import type { Overview } from "./reportsOverview.service.js";
import type { AttendanceReport, ExportView, AttendanceCallRow, PeriodKpis } from "./attendanceReport.service.js";
import type { ReportRow } from "./reports.service.js";
import type { Consolidated } from "./consolidated.service.js";
import type { AgentTimeRow } from "./agentTime.service.js";
import { addCharts, colRef, type ChartSpec } from "./excelCharts.service.js";

/** Gráfico à direita da tabela da folha (as linhas de dados começam na 5). */
function beside(nCols: number, slot = 0, height = 18): Pick<ChartSpec, "from" | "to"> {
  const row = 3 + slot * (height + 1);
  return { from: { col: nCols + 1, row }, to: { col: nCols + 10, row: row + height } };
}
const lastRow = (n: number) => 4 + Math.max(n, 1);
type Fmt = "text" | "int" | "dec" | "pct" | "secs" | "date" | "datetime" | "money";

export interface Column {
  header: string;
  width: number;
  fmt: Fmt;
}
type Cell = string | number | Date | null;

const BLUE = "FF2A78D6";
const ZEBRA = "FFF5F7FA";
const HAIR = "FFE4E3DF";
const INK_2 = "FF52514E";

const NUM_FMT: Record<Fmt, string | undefined> = {
  text: undefined,
  int: "#,##0",
  dec: "0.0",
  pct: "0.0%",
  secs: "[h]:mm:ss",
  date: "dd/mm/yyyy",
  datetime: "dd/mm/yyyy hh:mm",
  money: '#,##0.00 "Kz"',
};

/** Converte o valor "de negócio" no que o Excel espera para o formato. */
function toCell(v: Cell, fmt: Fmt): Cell {
  if (v === null || v === undefined) return null;
  if (fmt === "pct" && typeof v === "number") return v / 100; // 82.5 → 0.825 (formato 0.0%)
  if (fmt === "secs" && typeof v === "number") return v / 86400; // segundos → fracção de dia
  if (fmt === "money" && typeof v === "number") return v / 100; // cêntimos → kwanzas
  return v;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("pt-PT");

/**
 * Folha com título, subtítulo e uma tabela formatada. Devolve a folha para
 * quem quiser acrescentar mais blocos por baixo.
 */
export function addTableSheet(
  wb: ExcelJS.Workbook,
  name: string,
  title: string,
  subtitle: string,
  columns: Column[],
  rows: Cell[][]
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name.slice(0, 31), {
    views: [{ state: "frozen", ySplit: 4 }],
    // Impressão: horizontal e a caber na largura (tabela + gráfico na mesma página).
    // Folhas curtas numa só página; listas longas (chamadas) ocupam as que precisarem.
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: rows.length > 60 ? 0 : 1, paperSize: 9 },
  });
  // +3: o botão do filtro ocupa espaço no cabeçalho e cortava o título da coluna.
  ws.columns = columns.map((c) => ({ width: Math.max(c.width, c.header.length + 1) + 3 }));

  ws.mergeCells(1, 1, 1, columns.length);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, columns.length);
  ws.getCell(2, 1).value = subtitle;
  ws.getCell(2, 1).font = { size: 10, color: { argb: INK_2 } };

  const head = ws.getRow(4);
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    cell.alignment = { vertical: "middle", horizontal: c.fmt === "text" ? "left" : "right", wrapText: true };
  });
  head.height = 22;

  rows.forEach((r, ri) => {
    const row = ws.getRow(5 + ri);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = toCell(r[i] ?? null, c.fmt);
      const nf = NUM_FMT[c.fmt];
      if (nf) cell.numFmt = nf;
      cell.alignment = { horizontal: c.fmt === "text" ? "left" : "right" };
      cell.border = { bottom: { style: "hair", color: { argb: HAIR } } };
      if (ri % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    });
  });

  if (rows.length === 0) {
    ws.getCell(5, 1).value = "Sem dados no período";
    ws.getCell(5, 1).font = { italic: true, color: { argb: INK_2 } };
  } else {
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: columns.length } };
  }
  return ws;
}

const subtitleOf = (tenant: string, from: string, to: string) => `${tenant} · ${fmtDate(from)} – ${fmtDate(to)} · gerado em ${new Date().toLocaleString("pt-PT")}`;

const TILE_LABEL: Record<string, string> = {
  total: "Total de chamadas",
  inbound: "Recebidas",
  outbound: "Efectuadas",
  newContacts: "Novos contactos",
  answered: "Atendidas",
  missed: "Não atendidas",
  tma: "TMA — tempo médio de atendimento",
  tme: "ASA — tempo médio de espera até atender",
  response: "Tempo de resposta (do toque ao atendimento)",
  wrapUp: "Pós-chamada (do fim até tipificar)",
};

// ── Folhas do atendimento (partilhadas pelo Resumo e pelos separadores) ──────

function agentsSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]): void {
  const S = "Por agente";
  const n = a.byAgent.length;
  const names = a.byAgent.map((r) => (r.name && r.name !== r.number ? r.name : r.number));
  const useNames = a.byAgent.every((r) => r.name && r.name !== r.number);
  const cat = { catRef: colRef(S, useNames ? 1 : 0, 5, lastRow(n)), categories: names };
  if (n > 0) {
    charts.push({
      sheet: S, type: "column", title: "Chamadas por agente", ...cat, ...beside(15, 0),
      series: [
        { name: "Atendeu", ref: colRef(S, 3, 5, lastRow(n)), values: a.byAgent.map((r) => r.answered) },
        { name: "Recusou", ref: colRef(S, 4, 5, lastRow(n)), values: a.byAgent.map((r) => r.rejected) },
        { name: "Não atendeu", ref: colRef(S, 5, 5, lastRow(n)), values: a.byAgent.map((r) => r.noAnswer) },
      ],
    });
    charts.push({
      sheet: S, type: "column", title: "% de atendimento por agente", ...cat, ...beside(15, 1), numFmt: "0%",
      series: [{ name: "% atendimento", ref: colRef(S, 7, 5, lastRow(n)), values: a.byAgent.map((r) => (r.answerRate ?? 0) / 100) }],
    });
  }
  addTableSheet(wb, S, "Atendimento por agente", sub, [
    { header: "Extensão", width: 10, fmt: "text" },
    { header: "Agente", width: 22, fmt: "text" },
    { header: "Tocou", width: 9, fmt: "int" },
    { header: "Atendeu", width: 9, fmt: "int" },
    { header: "Recusou", width: 9, fmt: "int" },
    { header: "Não atendeu", width: 11, fmt: "int" },
    { header: "Ocupado", width: 9, fmt: "int" },
    { header: "% atendimento", width: 13, fmt: "pct" },
    { header: "% recusa", width: 10, fmt: "pct" },
    { header: "TMA", width: 10, fmt: "secs" },
    { header: "ASA (espera)", width: 12, fmt: "secs" },
    { header: "Resposta", width: 10, fmt: "secs" },
    { header: "Tipificadas", width: 11, fmt: "int" },
    { header: "% não tipificadas", width: 14, fmt: "pct" },
    { header: "Pós-chamada", width: 12, fmt: "secs" },
    { header: "Δ % atendimento vs média (p.p.)", width: 16, fmt: "dec" },
    { header: "Δ TMA vs média (s)", width: 12, fmt: "int" },
    { header: "Δ resposta vs média (s)", width: 13, fmt: "int" },
  ], a.byAgent.map((r) => [
    r.number, r.name && r.name !== r.number ? r.name : null, r.offered, r.answered, r.rejected, r.noAnswer, r.busy,
    r.answerRate, r.rejectRate, r.tmaSecs, r.tmeSecs, r.responseSecs, r.typed, r.untypedRate, r.wrapUpSecs,
    r.vsTenant.answerRate, r.vsTenant.tmaSecs, r.vsTenant.responseSecs,
  ]));
}

const GROUP_COLS: Column[] = [
  { header: "Grupo", width: 22, fmt: "text" },
  { header: "Chamadas", width: 10, fmt: "int" },
  { header: "Atendidas", width: 10, fmt: "int" },
  { header: "Perdidas", width: 10, fmt: "int" },
  { header: "Abandonadas", width: 12, fmt: "int" },
  { header: "Desistências curtas", width: 12, fmt: "int" },
  { header: "Recusas", width: 9, fmt: "int" },
  { header: "SLA", width: 9, fmt: "pct" },
  { header: "Meta SLA", width: 9, fmt: "pct" },
  { header: "Limiar SLA (s)", width: 10, fmt: "int" },
  { header: "% atendimento", width: 13, fmt: "pct" },
  { header: "% abandono", width: 11, fmt: "pct" },
  { header: "TMA", width: 10, fmt: "secs" },
  { header: "ASA (espera)", width: 12, fmt: "secs" },
  { header: "ASA 90%", width: 10, fmt: "secs" },
  { header: "Maior espera", width: 11, fmt: "secs" },
  { header: "Δ % atendimento vs média (p.p.)", width: 16, fmt: "dec" },
  { header: "Δ SLA vs média (p.p.)", width: 12, fmt: "dec" },
  { header: "Δ TMA vs média (s)", width: 12, fmt: "int" },
  { header: "Δ ASA vs média (s)", width: 12, fmt: "int" },
];

/** Verde/vermelho conforme cumpre a meta (só quando há meta). */
function markTarget(cell: ExcelJS.Cell, value: number | null, target: number | null, higherIsBetter = true): void {
  if (value === null || target === null) return;
  const ok = higherIsBetter ? value >= target : value <= target;
  cell.font = { bold: true, color: { argb: ok ? "FF006300" : "FFD03B3B" } };
}

function groupsSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]): void {
  const S = "Por grupo";
  const n = a.byGroup.length;
  if (n > 0) {
    charts.push({
      sheet: S, type: "column", title: "Chamadas por grupo", ...beside(9),
      catRef: colRef(S, 0, 5, lastRow(n)), categories: a.byGroup.map((g) => (g.groupId ? g.name : "Directas")),
      series: [
        { name: "Atendidas", ref: colRef(S, 2, 5, lastRow(n)), values: a.byGroup.map((g) => g.answered) },
        { name: "Perdidas", ref: colRef(S, 3, 5, lastRow(n)), values: a.byGroup.map((g) => g.missed) },
        { name: "Abandonadas", ref: colRef(S, 4, 5, lastRow(n)), values: a.byGroup.map((g) => g.abandoned) },
      ],
    });
  }
  if (n > 0) {
    charts.push({
      sheet: S, type: "column", title: "SLA por grupo vs meta", ...beside(GROUP_COLS.length, 1), numFmt: "0%",
      catRef: colRef(S, 0, 5, lastRow(n)), categories: a.byGroup.map((g) => (g.groupId ? g.name : "Directas")),
      series: [
        { name: "SLA", ref: colRef(S, 7, 5, lastRow(n)), values: a.byGroup.map((g) => (g.slaPct ?? 0) / 100) },
        { name: "Meta", ref: colRef(S, 8, 5, lastRow(n)), values: a.byGroup.map((g) => (g.slaTargetPct ?? 0) / 100) },
      ],
    });
  }
  const ws = addTableSheet(wb, S, "Atendimento por grupo", sub, GROUP_COLS, a.byGroup.map((g) => [
    g.groupId ? g.name : "Directas", g.total, g.answered, g.missed, g.abandoned, g.shortAbandoned, g.rejected,
    g.slaPct, g.slaTargetPct, g.slaSecs, g.answerRate, g.abandonRate, g.tmaSecs, g.tmeSecs, g.asaP90Secs, g.maxWaitSecs,
    g.vsTenant.answerRate, g.vsTenant.slaPct, g.vsTenant.tmaSecs, g.vsTenant.tmeSecs,
  ]));
  a.byGroup.forEach((g, i) => markTarget(ws.getCell(5 + i, 8), g.slaPct, g.slaTargetPct));
}

function reasonsSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]): void {
  const S = "Motivos de recusa";
  const n = a.reasons.length;
  if (n > 0) {
    charts.push({
      sheet: S, type: "bar", title: "Recusas por motivo", ...beside(3),
      catRef: colRef(S, 0, 5, lastRow(n)), categories: a.reasons.map((r) => r.reason),
      series: [{ name: "Recusas", ref: colRef(S, 1, 5, lastRow(n)), values: a.reasons.map((r) => r.count) }],
    });
  }
  addTableSheet(wb, S, "Motivos de recusa", sub, [
    { header: "Motivo", width: 34, fmt: "text" },
    { header: "Recusas", width: 10, fmt: "int" },
    { header: "%", width: 9, fmt: "pct" },
  ], a.reasons.map((r) => [r.reason, r.count, r.pct]));
}

function typingSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]): void {
  const S = "Tipificação";
  const n = a.typing.length;
  // 1.ª coluna = nome completo, para os rótulos do gráfico; as outras dão para filtrar.
  const label = (r: (typeof a.typing)[number]) => (r.subcategory ? `${r.category} › ${r.subcategory}` : r.category);
  if (n > 0) {
    charts.push({
      sheet: S, type: "bar", title: "Chamadas por tipificação", ...beside(5, 0, Math.max(18, n + 4)),
      catRef: colRef(S, 0, 5, lastRow(n)), categories: a.typing.map(label),
      series: [{ name: "Chamadas", ref: colRef(S, 3, 5, lastRow(n)), values: a.typing.map((r) => r.count) }],
    });
  }
  addTableSheet(wb, S, "Chamadas por tipificação", sub, [
    { header: "Tipificação", width: 34, fmt: "text" },
    { header: "Categoria", width: 20, fmt: "text" },
    { header: "Subcategoria", width: 20, fmt: "text" },
    { header: "Chamadas", width: 10, fmt: "int" },
    { header: "%", width: 9, fmt: "pct" },
  ], a.typing.map((r) => [label(r), r.category, r.subcategory, r.count, r.pct]));
}

/**
 * Folha de indicadores: uma linha por indicador, cada uma com o seu formato
 * (contagem, %, duração). `cols` = cabeçalhos das colunas de valores.
 */
export function addKpiSheet(
  wb: ExcelJS.Workbook,
  name: string,
  title: string,
  subtitle: string,
  cols: string[],
  rows: { label: string; fmt: Fmt; values: (number | null)[]; target?: { value: number | null; higherIsBetter: boolean } }[]
): ExcelJS.Worksheet {
  const ws = addTableSheet(wb, name, title, subtitle, [{ header: "Indicador", width: 40, fmt: "text" }, ...cols.map((h) => ({ header: h, width: 16, fmt: "text" as Fmt }))], []);
  ws.autoFilter = undefined as never;
  rows.forEach((r, i) => {
    const row = ws.getRow(5 + i);
    row.getCell(1).value = r.label;
    r.values.forEach((v, j) => {
      const c = row.getCell(2 + j);
      c.value = toCell(v, r.fmt);
      const nf = NUM_FMT[r.fmt];
      if (nf) c.numFmt = nf;
      c.alignment = { horizontal: "right" };
      if (j === 0 && r.target) markTarget(c, v, r.target.value, r.target.higherIsBetter);
    });
    for (let c = 1; c <= cols.length + 1; c++) {
      if (i % 2 === 1) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
      row.getCell(c).border = { bottom: { style: "hair", color: { argb: HAIR } } };
    }
  });
  return ws;
}

/** Os indicadores do separador Atendimento (os cartões e a comparação com a conta). */
function indicatorsSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, filtered: boolean): void {
  const c = a.selection.calls;
  const g = a.selection.agents;
  const tc = a.tenant.calls;
  const ta = a.tenant.agents;
  const both = (x: number | null, y: number | null) => (filtered ? [x, y] : [x]);
  const rows: Parameters<typeof addKpiSheet>[5] = [
    { label: "Chamadas", fmt: "int", values: both(c.total, tc.total) },
    { label: "Atendidas", fmt: "int", values: both(c.answered, tc.answered) },
    { label: "% atendimento", fmt: "pct", values: both(c.answerRate, tc.answerRate) },
    { label: "Perdidas", fmt: "int", values: both(c.missed, tc.missed) },
    { label: "Abandonadas (quem ligou desligou)", fmt: "int", values: both(c.abandoned, tc.abandoned) },
    { label: `Desistências curtas (antes de ${a.shortAbandonSecs} s, fora do SLA)`, fmt: "int", values: both(c.shortAbandoned, tc.shortAbandoned) },
    { label: "% abandono (sem as curtas)", fmt: "pct", values: both(c.abandonRate, tc.abandonRate) },
    ...(a.limited ? [] : [
      { label: "Recusadas", fmt: "int" as Fmt, values: both(g.rejected, ta.rejected) },
      { label: "% recusa", fmt: "pct" as Fmt, values: both(g.rejectRate, ta.rejectRate) },
    ]),
    { label: `SLA (atendidas em menos de ${a.slaSecs} s)`, fmt: "pct", values: both(c.slaPct, tc.slaPct), target: { value: a.slaTargetPct, higherIsBetter: true } },
    { label: "Meta do SLA", fmt: "pct", values: both(a.slaTargetPct, a.slaTargetPct) },
    { label: "Atendidas dentro do SLA", fmt: "int", values: both(c.slaMet, tc.slaMet) },
    { label: "TMA — tempo médio de atendimento", fmt: "secs", values: both(c.tmaSecs, tc.tmaSecs) },
    { label: "ASA — tempo médio de espera até atender", fmt: "secs", values: both(c.tmeSecs, tc.tmeSecs) },
    { label: "ASA 90% — 9 em cada 10 atendidas esperaram até", fmt: "secs", values: both(c.asaP90Secs, tc.asaP90Secs) },
    { label: "Maior espera", fmt: "secs", values: both(c.maxWaitSecs, tc.maxWaitSecs) },
    ...(a.limited ? [] : [
      { label: "Tempo de resposta do agente", fmt: "secs" as Fmt, values: both(g.responseSecs, ta.responseSecs) },
      { label: "Tipificadas", fmt: "int" as Fmt, values: both(g.typed, ta.typed) },
      { label: "Não tipificadas", fmt: "int" as Fmt, values: both(g.untyped, ta.untyped) },
      { label: "% não tipificadas", fmt: "pct" as Fmt, values: both(g.untypedRate, ta.untypedRate) },
      { label: "Pós-chamada (do fim até tipificar)", fmt: "secs" as Fmt, values: both(g.wrapUpSecs, ta.wrapUpSecs) },
    ]),
  ];
  addKpiSheet(wb, "Indicadores", "Indicadores de atendimento", sub, filtered ? ["Selecção", "Média da conta"] : ["Valor"], rows);
}

const PERIOD_COLS: Column[] = [
  { header: "Chamadas", width: 10, fmt: "int" },
  { header: "Atendidas", width: 10, fmt: "int" },
  { header: "Perdidas", width: 10, fmt: "int" },
  { header: "Abandonadas", width: 12, fmt: "int" },
  { header: "Desistências curtas", width: 12, fmt: "int" },
  { header: "% atendimento", width: 13, fmt: "pct" },
  { header: "SLA", width: 9, fmt: "pct" },
  { header: "Meta SLA", width: 9, fmt: "pct" },
  { header: "TMA", width: 10, fmt: "secs" },
  { header: "ASA (espera)", width: 12, fmt: "secs" },
  { header: "ASA 90%", width: 10, fmt: "secs" },
  { header: "Maior espera", width: 11, fmt: "secs" },
];
const periodCells = (r: PeriodKpis, target: number | null): Cell[] => [
  r.total, r.answered, r.missed, r.abandoned, r.shortAbandoned, r.answerRate, r.slaPct, target, r.tmaSecs, r.tmeSecs, r.asaP90Secs, r.maxWaitSecs,
];

/** Por dia: volume, SLA (com a meta, para o gráfico) e tempos. */
function daySheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]): void {
  const S = "Por dia";
  const rows = a.byDay;
  const n = rows.length;
  const cols: Column[] = [{ header: "Dia", width: 12, fmt: "date" }, ...PERIOD_COLS, { header: "Resposta", width: 10, fmt: "secs" }, { header: "Pós-chamada", width: 12, fmt: "secs" }];
  if (n > 0) {
    const cat = {
      catRef: colRef(S, 0, 5, lastRow(n)), categories: rows.map((d) => `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`), catDateFmt: "dd/mm",
      catValues: rows.map((d) => Math.round((Date.UTC(+d.date.slice(0, 4), +d.date.slice(5, 7) - 1, +d.date.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000)),
    };
    charts.push({
      sheet: S, type: "line", title: "SLA por dia vs meta", ...cat, ...beside(cols.length, 0), numFmt: "0%",
      series: [
        { name: "SLA", ref: colRef(S, 7, 5, lastRow(n)), values: rows.map((d) => (d.slaPct === null ? null : d.slaPct / 100)) },
        ...(a.slaTargetPct !== null ? [{ name: "Meta", ref: colRef(S, 8, 5, lastRow(n)), values: rows.map(() => a.slaTargetPct! / 100) }] : []),
      ],
    });
    charts.push({
      sheet: S, type: "column", title: "Chamadas por dia", ...cat, ...beside(cols.length, 1),
      series: [
        { name: "Atendidas", ref: colRef(S, 2, 5, lastRow(n)), values: rows.map((d) => d.answered) },
        { name: "Perdidas", ref: colRef(S, 3, 5, lastRow(n)), values: rows.map((d) => d.missed) },
      ],
    });
  }
  const ws = addTableSheet(wb, S, "Atendimento por dia", sub, cols, rows.map((d) => [new Date(`${d.date}T12:00:00`), ...periodCells(d, a.slaTargetPct), d.responseSecs, d.wrapUpSecs]));
  rows.forEach((d, i) => markTarget(ws.getCell(5 + i, 8), d.slaPct, a.slaTargetPct));
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** As 24 horas: onde se concentram as chamadas e onde o SLA cai. */
function hourSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]): void {
  const S = "Por hora";
  const rows = a.byHour;
  if (!rows.length) return;
  const cols: Column[] = [{ header: "Hora", width: 8, fmt: "text" }, ...PERIOD_COLS];
  const cat = { catRef: colRef(S, 0, 5, lastRow(24)), categories: rows.map((r) => hh(r.hour)) };
  charts.push({
    sheet: S, type: "column", title: "Chamadas por hora", ...cat, ...beside(cols.length, 0),
    series: [
      { name: "Atendidas", ref: colRef(S, 2, 5, lastRow(24)), values: rows.map((r) => r.answered) },
      { name: "Perdidas", ref: colRef(S, 3, 5, lastRow(24)), values: rows.map((r) => r.missed) },
    ],
  });
  charts.push({
    sheet: S, type: "line", title: "SLA e ASA por hora — SLA", ...cat, ...beside(cols.length, 1), numFmt: "0%",
    series: [{ name: "SLA", ref: colRef(S, 7, 5, lastRow(24)), values: rows.map((r) => (r.slaPct === null ? null : r.slaPct / 100)) }],
  });
  const ws = addTableSheet(wb, S, "Atendimento por hora do dia", `${sub} · hora a que a chamada começou a tocar`, cols, rows.map((r) => [hh(r.hour), ...periodCells(r, a.slaTargetPct)]));
  rows.forEach((r, i) => markTarget(ws.getCell(5 + i, 8), r.slaPct, a.slaTargetPct));
}

export const WEEKDAYS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

/** Mapa de calor dia da semana × hora (escala de cor do próprio Excel). */
function heatmapSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string): void {
  const grid = a.byWeekdayHour;
  if (!grid.length) return;
  const cols: Column[] = [{ header: "Dia", width: 11, fmt: "text" }, ...Array.from({ length: 24 }, (_, h) => ({ header: String(h).padStart(2, "0"), width: 3, fmt: "int" as Fmt })), { header: "Total", width: 8, fmt: "int" }];
  const ws = addTableSheet(wb, "Mapa de horas", "Chamadas por dia da semana e hora", `${sub} · mais escuro = mais chamadas`, cols, grid.map((row, i) => [WEEKDAYS[i]!, ...row, row.reduce((x, y) => x + y, 0)]));
  ws.autoFilter = undefined as never;
  for (let r = 5; r <= 11; r++) for (let c = 2; c <= 25; c++) ws.getCell(r, c).fill = { type: "pattern", pattern: "none" };
  ws.addConditionalFormatting({
    ref: "B5:Y11",
    rules: [{ type: "colorScale", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], color: [{ argb: "FFFFFFFF" }, { argb: BLUE }] }],
  });
}

const OUTCOME: Record<string, string> = {
  ANSWERED: "Atendeu", REJECTED: "Recusou", NO_ANSWER: "Não atendeu", BUSY: "Ocupado", CANCELLED: "Cancelada", FAILED: "Falhou",
};

/** Lista das chamadas de entrada (separador Chamadas), com as extensões em que tocou. */
function attendanceCallsSheet(wb: ExcelJS.Workbook, calls: AttendanceCallRow[], sub: string): void {
  addTableSheet(wb, "Chamadas", "Chamadas de entrada", sub, [
    { header: "Data", width: 17, fmt: "datetime" },
    { header: "Número", width: 16, fmt: "text" },
    { header: "Contacto", width: 24, fmt: "text" },
    { header: "Grupo", width: 16, fmt: "text" },
    { header: "Resultado", width: 11, fmt: "text" },
    { header: "Espera", width: 9, fmt: "secs" },
    { header: "Conversa", width: 9, fmt: "secs" },
    { header: "Atendida por", width: 12, fmt: "text" },
    { header: "Tipificação", width: 28, fmt: "text" },
    { header: "Nota da tipificação", width: 28, fmt: "text" },
    { header: "Extensões (resultado, motivo)", width: 50, fmt: "text" },
  ], calls.map((c) => {
    const ans = c.legs.find((l) => l.outcome === "ANSWERED");
    return [
      c.startedAt ? new Date(c.startedAt) : null, c.from, c.contactName, c.group, c.answered ? "Atendida" : "Perdida", c.waitSecs, c.talkSecs,
      ans?.extension ?? null, ans?.typing ?? null, ans?.typingNote ?? null,
      c.legs.map((l) => `${l.extension} ${OUTCOME[l.outcome ?? ""] ?? "A tocar"}${l.reason ? ` (${l.reason})` : ""}`).join(" · "),
    ];
  }));
}

/** Separador Atendimento: indicadores, por dia, por hora e mapa de horas. */
function attendanceSheets(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[], filtered = false): void {
  indicatorsSheet(wb, a, sub, filtered);
  if (a.limited) return;
  daySheet(wb, a, sub, charts);
  hourSheet(wb, a, sub, charts);
  heatmapSheet(wb, a, sub);
}

const VIEW_SHEET: Record<Exclude<ExportView, "attendance" | "calls">, (wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]) => void> = {
  agents: agentsSheet,
  groups: groupsSheet,
  reasons: reasonsSheet,
  typing: typingSheet,
};

/** Um separador do atendimento (por agente, por grupo, motivos, tipificação). */
/** Folha "Análise IA" (melhoria 6): a última análise dos mesmos filtros, se houver. */
export function addAnalysisSheet(wb: ExcelJS.Workbook, a: ExportAnalysis): void {
  const ws = wb.addWorksheet("Análise IA", { pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  ws.columns = [{ width: 110 }];
  ws.getCell(1, 1).value = "Análise com IA";
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = `Gerada em ${a.createdAt.toLocaleString("pt-PT")} · baseada no resumo agregado destes filtros · interpretação automática, confirme antes de decidir`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: INK_2 } };
  let row = 4;
  for (const s of analysisSections(a.result)) {
    const h = ws.getCell(row++, 1);
    h.value = s.title;
    h.font = { bold: true, size: 12, color: { argb: BLUE } };
    for (const line of s.lines) {
      const c = ws.getCell(row++, 1);
      c.value = line;
      c.alignment = { wrapText: true, vertical: "top" };
    }
    row++;
  }
}

export interface ExportAnalysis {
  result: AnalysisResult;
  createdAt: Date;
}

export async function attendanceWorkbook(
  report: AttendanceReport,
  view: ExportView,
  tenant: string,
  analysis?: ExportAnalysis | null,
  extra: { calls?: AttendanceCallRow[]; filters?: string } = {}
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Falaí";
  const charts: ChartSpec[] = [];
  // Os filtros activos (agente, grupo, tipificação) vão no subtítulo de cada folha.
  const sub = subtitleOf(tenant, report.from, report.to) + (extra.filters ? ` · ${extra.filters}` : "");
  if (view === "attendance") attendanceSheets(wb, report, sub, charts, Boolean(extra.filters));
  else if (view === "calls") attendanceCallsSheet(wb, extra.calls ?? [], sub);
  else VIEW_SHEET[view](wb, report, sub, charts);
  if (analysis) addAnalysisSheet(wb, analysis);
  return addCharts(Buffer.from(await wb.xlsx.writeBuffer()), wb.worksheets.map((w) => w.name), charts);
}

/**
 * O Resumo completo: indicadores com o período anterior e a variação, por dia,
 * repartições, as folhas do atendimento e a lista das chamadas.
 */
export async function overviewWorkbook(o: Overview, rows: ReportRow[], tenant: string, analysis?: ExportAnalysis | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Falaí";
  const sub = subtitleOf(tenant, o.from, o.to);
  const charts: ChartSpec[] = [];
  // Resumo: só os indicadores de contagem (os tempos têm outra escala — outro gráfico seria preciso).
  const counts = o.tiles.filter((t) => t.unit === "count");
  charts.push({
    sheet: "Resumo", type: "column", title: "Período vs período anterior", ...beside(4),
    catRef: colRef("Resumo", 0, 5, 4 + counts.length), categories: counts.map((t) => TILE_LABEL[t.key] ?? t.key),
    series: [
      { name: "Período", ref: colRef("Resumo", 1, 5, 4 + counts.length), values: counts.map((t) => t.value) },
      { name: "Período anterior", ref: colRef("Resumo", 2, 5, 4 + counts.length), values: counts.map((t) => t.previous) },
    ],
  });

  const ws = addTableSheet(wb, "Resumo", "Resumo de chamadas", `${sub} · comparado com ${fmtDate(o.previousFrom)} – ${fmtDate(o.previousTo)}`, [
    { header: "Indicador", width: 44, fmt: "text" },
    { header: "Período", width: 14, fmt: "text" },
    { header: "Período anterior", width: 16, fmt: "text" },
    { header: "Variação", width: 11, fmt: "pct" },
  ], []);
  // Linha a linha: cada indicador tem o seu formato (contagem ou duração).
  const ordered = [...o.tiles.filter((t) => t.unit === "count"), ...o.tiles.filter((t) => t.unit !== "count")];
  ordered.forEach((t, i) => {
    const row = ws.getRow(5 + i);
    const fmt: Fmt = t.unit === "secs" ? "secs" : "int";
    row.getCell(1).value = TILE_LABEL[t.key] ?? t.key;
    for (const [col, v] of [[2, t.value], [3, t.previous]] as const) {
      const c = row.getCell(col);
      c.value = toCell(v, fmt);
      c.numFmt = NUM_FMT[fmt]!;
      c.alignment = { horizontal: "right" };
    }
    const d = row.getCell(4);
    d.value = toCell(t.deltaPct, "pct");
    d.numFmt = '+0.0%;-0.0%;0.0%';
    d.alignment = { horizontal: "right" };
    // Cor da variação: subir é bom/mau conforme o indicador.
    if (t.deltaPct !== null && t.deltaPct !== 0 && t.good !== "neutral") {
      const good = (t.good === "up") === t.deltaPct > 0;
      d.font = { color: { argb: good ? "FF006300" : "FFD03B3B" }, bold: true };
    }
    if (i % 2 === 1) for (let c = 1; c <= 4; c++) row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
    for (let c = 1; c <= 4; c++) row.getCell(c).border = { bottom: { style: "hair", color: { argb: HAIR } } };
  });
  ws.getCell(5, 1).font = { bold: false };
  ws.getCell(6 + o.tiles.length, 1).value = "Sem base de comparação = o período anterior não tem dados.";
  ws.getCell(6 + o.tiles.length, 1).font = { italic: true, size: 9, color: { argb: INK_2 } };

  const nd = o.daily.length;
  charts.push({
    sheet: "Por dia", type: "line", title: "Chamadas por dia", ...beside(4, 0, 20),
    catRef: colRef("Por dia", 0, 5, lastRow(nd)), categories: o.daily.map((d) => `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`),
    // Número de série do Excel (dias desde 30/12/1899) — a coluna A tem datas.
    catDateFmt: "dd/mm",
    catValues: o.daily.map((d) => Math.round((Date.UTC(+d.date.slice(0, 4), +d.date.slice(5, 7) - 1, +d.date.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000)),
    series: [
      { name: "Total", ref: colRef("Por dia", 1, 5, lastRow(nd)), values: o.daily.map((d) => d.total) },
      { name: "Atendidas", ref: colRef("Por dia", 2, 5, lastRow(nd)), values: o.daily.map((d) => d.answered) },
    ],
  });
  addTableSheet(wb, "Por dia", "Chamadas por dia", sub, [
    { header: "Dia", width: 12, fmt: "date" },
    { header: "Total", width: 10, fmt: "int" },
    { header: "Atendidas", width: 10, fmt: "int" },
    { header: "% atendidas", width: 12, fmt: "pct" },
  ], o.daily.map((d) => [new Date(`${d.date}T12:00:00`), d.total, d.answered, d.total ? Math.round((d.answered / d.total) * 1000) / 10 : null]));

  const share = (label: string, slices: { label: string; value: number }[]) => {
    const total = slices.reduce((s, x) => s + x.value, 0);
    return slices.map((s) => [label, s.label, s.value, total ? Math.round((s.value / total) * 1000) / 10 : null] as Cell[]);
  };
  // Um anel por dimensão; as linhas de cada uma são contíguas na folha.
  let start = 5;
  ([["Por grupo", o.donuts.byGroup], ["Por estado", o.donuts.byState], ["Por tipificação", o.donuts.byTyping]] as const).forEach(([title, slices], i) => {
    if (slices.length > 0) {
      const end = start + slices.length - 1;
      charts.push({
        sheet: "Repartição", type: "doughnut", title, ...beside(4, i, 15),
        catRef: colRef("Repartição", 1, start, end), categories: slices.map((s) => s.label),
        series: [{ name: title, ref: colRef("Repartição", 2, start, end), values: slices.map((s) => s.value) }],
      });
    }
    start += slices.length;
  });
  addTableSheet(wb, "Repartição", "Repartição das chamadas de entrada", sub, [
    { header: "Dimensão", width: 16, fmt: "text" },
    { header: "Valor", width: 24, fmt: "text" },
    { header: "Chamadas", width: 10, fmt: "int" },
    { header: "%", width: 9, fmt: "pct" },
  ], [...share("Grupo", o.donuts.byGroup), ...share("Estado", o.donuts.byState), ...share("Tipificação", o.donuts.byTyping)]);

  attendanceSheets(wb, o.attendance, sub, charts);
  if (!o.limited) {
    agentsSheet(wb, o.attendance, sub, charts);
    groupsSheet(wb, o.attendance, sub, charts);
    reasonsSheet(wb, o.attendance, sub, charts);
    typingSheet(wb, o.attendance, sub, charts);
  }

  const DIR: Record<string, string> = { inbound: "Entrada", outbound: "Saída", internal: "Interna" };
  const STATUS: Record<string, string> = {
    COMPLETED: "Concluída",
    ESCALATED: "Escalada",
    NO_ANSWER: "Não atendida",
    BUSY: "Ocupado",
    FAILED: "Falhou",
    CANCELLED: "Cancelada",
    IN_PROGRESS: "Em curso",
    RINGING: "A tocar",
    DIALING: "A marcar",
    QUEUED: "Em fila",
  };
  addTableSheet(wb, "Chamadas", "Lista de chamadas", sub, [
    { header: "Data", width: 17, fmt: "datetime" },
    { header: "Direcção", width: 10, fmt: "text" },
    { header: "Número", width: 16, fmt: "text" },
    { header: "Contacto", width: 24, fmt: "text" },
    { header: "Estado", width: 13, fmt: "text" },
    { header: "Resultado", width: 14, fmt: "text" },
    { header: "Duração", width: 10, fmt: "secs" },
    { header: "Custo", width: 12, fmt: "money" },
  ], rows.map((r) => [r.date, DIR[r.direction] ?? r.direction, r.party, r.contactName, STATUS[r.status] ?? r.status, r.outcome && r.outcome !== r.status ? r.outcome : null, r.durationSecs, r.costCents]));
  if (analysis) addAnalysisSheet(wb, analysis);

  return addCharts(Buffer.from(await wb.xlsx.writeBuffer()), wb.worksheets.map((w) => w.name), charts);
}

// ── Consolidado (painel de direcção) ─────────────────────────────────────────

export const CHANNEL_LABEL: Record<string, string> = { VOICE: "Voz", WHATSAPP: "WhatsApp", WEBCHAT: "Chat do site", EMAIL: "Email", TELEGRAM: "Telegram" };
const PRIORITY_LABEL: Record<string, string> = { URGENT: "Urgente", HIGH: "Alta", MEDIUM: "Média", LOW: "Baixa" };
const BUCKET_LABEL: Record<string, string> = { day: "por dia", week: "por semana (começa à segunda)", month: "por mês" };

/** O separador Consolidado: indicadores, por canal, tickets por prioridade e a série. */
export async function consolidatedWorkbook(c: Consolidated, tenant: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Falaí";
  const sub = subtitleOf(tenant, c.from, c.to);
  const charts: ChartSpec[] = [];
  const k = c.kpis;
  const tg = c.targets;
  addKpiSheet(wb, "Indicadores", "Painel de direcção — indicadores", sub, ["Valor", "Meta"], [
    { label: "Contactos (chamadas de entrada + conversas)", fmt: "int", values: [k.contacts, null] },
    { label: "Chamadas de entrada", fmt: "int", values: [k.calls.total, null] },
    { label: "% chamadas atendidas", fmt: "pct", values: [k.calls.answerRate, null] },
    { label: `SLA voz (atendidas em menos de ${tg.slaSecs} s)`, fmt: "pct", values: [k.calls.slaPct, tg.slaTargetPct], target: { value: tg.slaTargetPct, higherIsBetter: true } },
    { label: "ASA — espera média até atender", fmt: "secs", values: [k.calls.tmeSecs, null] },
    { label: "ASA 90%", fmt: "secs", values: [k.calls.asaP90Secs, null] },
    { label: "TMA — tempo médio de atendimento", fmt: "secs", values: [k.calls.tmaSecs, null] },
    { label: "Chamadas de saída", fmt: "int", values: [k.callsOut, null] },
    { label: "Conversas", fmt: "int", values: [k.conversations, null] },
    { label: "Conversas resolvidas", fmt: "int", values: [k.conversationsResolved, null] },
    { label: "Texto — 1.ª resposta (média)", fmt: "secs", values: [k.textFirstResponseSecs, null] },
    { label: `SLA texto (1.ª resposta em menos de ${Math.round(tg.textSlaSecs / 60)} min)`, fmt: "pct", values: [k.textSla.slaPct, tg.textSlaTargetPct], target: { value: tg.textSlaTargetPct, higherIsBetter: true } },
    { label: "Texto — respondidas a tempo", fmt: "int", values: [k.textSla.met, null] },
    { label: "Texto — fora do prazo ou sem resposta", fmt: "int", values: [k.textSla.missed, null] },
    { label: "Tickets criados", fmt: "int", values: [k.ticketsCreated, null] },
    { label: "Tickets resolvidos", fmt: "int", values: [k.ticketsResolved, null] },
    { label: "Tempo médio de resolução", fmt: "secs", values: [k.ticketResolutionSecs, null] },
    { label: "SLA tickets (resolvidos dentro do prazo)", fmt: "pct", values: [k.ticketSla.slaPct, tg.ticketSlaTargetPct], target: { value: tg.ticketSlaTargetPct, higherIsBetter: true } },
    { label: "Tickets com prazo violado (criados no período)", fmt: "int", values: [k.ticketSla.breached, null] },
    { label: "Tickets atrasados agora (em aberto, de qualquer data)", fmt: "int", values: [k.ticketsOverdueNow, null] },
    { label: "Satisfação — média (1 a 5)", fmt: "dec", values: [k.csat.avg, null] },
    { label: "Satisfação — % satisfeitos (4 e 5)", fmt: "pct", values: [k.csat.satisfiedPct, null] },
    { label: "Satisfação — respostas", fmt: "int", values: [k.csat.responses, null] },
    { label: "QA — nota média", fmt: "dec", values: [k.qa.avgScore, null] },
    { label: "QA — avaliações", fmt: "int", values: [k.qa.evaluations, null] },
  ]);

  const n = c.byChannel.length;
  if (n > 0) {
    charts.push({
      sheet: "Por canal", type: "bar", title: "Contactos por canal", ...beside(4),
      catRef: colRef("Por canal", 0, 5, lastRow(n)), categories: c.byChannel.map((x) => CHANNEL_LABEL[x.channel] ?? x.channel),
      series: [{ name: "Contactos", ref: colRef("Por canal", 1, 5, lastRow(n)), values: c.byChannel.map((x) => x.contacts) }],
    });
  }
  addTableSheet(wb, "Por canal", "Contactos por canal", `${sub} · voz: espera até atender e SLA de voz; texto: 1.ª resposta e SLA de texto`, [
    { header: "Canal", width: 16, fmt: "text" },
    { header: "Contactos", width: 10, fmt: "int" },
    { header: "1.ª resposta / ASA", width: 14, fmt: "secs" },
    { header: "SLA", width: 9, fmt: "pct" },
  ], c.byChannel.map((x) => [CHANNEL_LABEL[x.channel] ?? x.channel, x.contacts, x.firstResponseSecs, x.slaPct]));

  const tws = addTableSheet(wb, "Tickets por prioridade", "SLA dos tickets por prioridade", `${sub} · tickets criados no período`, [
    { header: "Prioridade", width: 12, fmt: "text" },
    { header: "Prazo (horas)", width: 11, fmt: "dec" },
    { header: "Criados", width: 9, fmt: "int" },
    { header: "Com prazo", width: 10, fmt: "int" },
    { header: "Dentro do prazo", width: 12, fmt: "int" },
    { header: "Prazo violado", width: 12, fmt: "int" },
    { header: "Em aberto (a tempo)", width: 14, fmt: "int" },
    { header: "SLA", width: 9, fmt: "pct" },
    { header: "Meta SLA", width: 9, fmt: "pct" },
    { header: "Tempo médio de resolução", width: 16, fmt: "secs" },
  ], c.ticketsByPriority.map((p) => [PRIORITY_LABEL[p.priority] ?? p.priority, p.targetHours, p.created, p.withDue, p.met, p.breached, p.open, p.slaPct, tg.ticketSlaTargetPct, p.resolutionSecs]));
  c.ticketsByPriority.forEach((p, i) => markTarget(tws.getCell(5 + i, 8), p.slaPct, tg.ticketSlaTargetPct));

  const sn = c.series.length;
  if (sn > 0) {
    charts.push({
      sheet: "Por período", type: "line", title: "SLA por período (voz, texto, tickets)", ...beside(14), numFmt: "0%",
      catRef: colRef("Por período", 0, 5, lastRow(sn)), categories: c.series.map((r) => r.period),
      series: [
        { name: "Voz", ref: colRef("Por período", 4, 5, lastRow(sn)), values: c.series.map((r) => (r.callsSlaPct === null ? null : r.callsSlaPct / 100)) },
        { name: "Texto", ref: colRef("Por período", 8, 5, lastRow(sn)), values: c.series.map((r) => (r.textSlaPct === null ? null : r.textSlaPct / 100)) },
        { name: "Tickets", ref: colRef("Por período", 12, 5, lastRow(sn)), values: c.series.map((r) => (r.ticketSlaPct === null ? null : r.ticketSlaPct / 100)) },
      ],
    });
  }
  addTableSheet(wb, "Por período", `Evolução ${BUCKET_LABEL[c.bucket] ?? ""}`, sub, [
    { header: "Período", width: 12, fmt: "text" },
    { header: "Chamadas de entrada", width: 11, fmt: "int" },
    { header: "Atendidas", width: 10, fmt: "int" },
    { header: "Perdidas", width: 10, fmt: "int" },
    { header: "SLA voz", width: 9, fmt: "pct" },
    { header: "Chamadas de saída", width: 10, fmt: "int" },
    { header: "Conversas", width: 10, fmt: "int" },
    { header: "Resolvidas", width: 10, fmt: "int" },
    { header: "SLA texto", width: 9, fmt: "pct" },
    { header: "Tickets criados", width: 10, fmt: "int" },
    { header: "Tickets resolvidos", width: 10, fmt: "int" },
    { header: "Prazo violado", width: 10, fmt: "int" },
    { header: "SLA tickets", width: 10, fmt: "pct" },
  ], c.series.map((r) => [r.period, r.callsIn, r.callsAnswered, r.callsMissed, r.callsSlaPct, r.callsOut, r.conversations, r.conversationsResolved, r.textSlaPct, r.ticketsCreated, r.ticketsResolved, r.ticketsBreached, r.ticketSlaPct]));

  return addCharts(Buffer.from(await wb.xlsx.writeBuffer()), wb.worksheets.map((w) => w.name), charts);
}

// ── Tempo dos agentes ────────────────────────────────────────────────────────

/** Separador Tempo dos agentes: um agente por linha e as pausas por motivo. */
export async function agentTimeWorkbook(r: { from: string; to: string; data: AgentTimeRow[] }, tenant: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Falaí";
  const sub = subtitleOf(tenant, r.from, r.to);
  addTableSheet(wb, "Tempo dos agentes", "Tempo dos agentes", `${sub} · aderência = ligado dentro do turno ÷ escalado`, [
    { header: "Agente", width: 24, fmt: "text" },
    { header: "Escalado", width: 11, fmt: "secs" },
    { header: "Ligado", width: 11, fmt: "secs" },
    { header: "Ligado no turno", width: 13, fmt: "secs" },
    { header: "Aderência", width: 10, fmt: "pct" },
    { header: "Em pausa", width: 11, fmt: "secs" },
    { header: "Pausas", width: 8, fmt: "int" },
  ], r.data.map((a) => [a.name, a.scheduledSecs, a.loggedSecs, a.loggedInShiftSecs, a.adherencePct, a.pausedSecs, a.pauses.reduce((n, p) => n + p.count, 0)]));
  addTableSheet(wb, "Pausas por motivo", "Pausas por motivo", sub, [
    { header: "Agente", width: 24, fmt: "text" },
    { header: "Motivo", width: 24, fmt: "text" },
    { header: "Tempo", width: 11, fmt: "secs" },
    { header: "Pausas", width: 8, fmt: "int" },
  ], r.data.flatMap((a) => a.pauses.map((p) => [a.name, p.reason ?? "Sem motivo", p.secs, p.count])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
