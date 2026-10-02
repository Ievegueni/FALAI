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
import type { AttendanceReport, ExportView } from "./attendanceReport.service.js";
import type { ReportRow } from "./reports.service.js";
import { addCharts, colRef, type ChartSpec } from "./excelCharts.service.js";

/** Gráfico à direita da tabela da folha (as linhas de dados começam na 5). */
function beside(nCols: number, slot = 0, height = 18): Pick<ChartSpec, "from" | "to"> {
  const row = 3 + slot * (height + 1);
  return { from: { col: nCols + 1, row }, to: { col: nCols + 10, row: row + height } };
}
const lastRow = (n: number) => 4 + Math.max(n, 1);
type Fmt = "text" | "int" | "pct" | "secs" | "date" | "datetime" | "money";

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
  tme: "TME — tempo médio de espera",
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
    { header: "TME", width: 10, fmt: "secs" },
    { header: "Resposta", width: 10, fmt: "secs" },
    { header: "Tipificadas", width: 11, fmt: "int" },
    { header: "% não tipificadas", width: 14, fmt: "pct" },
    { header: "Pós-chamada", width: 12, fmt: "secs" },
  ], a.byAgent.map((r) => [
    r.number, r.name && r.name !== r.number ? r.name : null, r.offered, r.answered, r.rejected, r.noAnswer, r.busy,
    r.answerRate, r.rejectRate, r.tmaSecs, r.tmeSecs, r.responseSecs, r.typed, r.untypedRate, r.wrapUpSecs,
  ]));
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
  addTableSheet(wb, S, "Atendimento por grupo", sub, [
    { header: "Grupo", width: 22, fmt: "text" },
    { header: "Chamadas", width: 10, fmt: "int" },
    { header: "Atendidas", width: 10, fmt: "int" },
    { header: "Perdidas", width: 10, fmt: "int" },
    { header: "Abandonadas", width: 12, fmt: "int" },
    { header: "Recusas", width: 9, fmt: "int" },
    { header: "% atendimento", width: 13, fmt: "pct" },
    { header: "TMA", width: 10, fmt: "secs" },
    { header: "TME", width: 10, fmt: "secs" },
  ], a.byGroup.map((g) => [g.groupId ? g.name : "Directas", g.total, g.answered, g.missed, g.abandoned, g.rejected, g.answerRate, g.tmaSecs, g.tmeSecs]));
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

const VIEW_SHEET: Record<ExportView, (wb: ExcelJS.Workbook, a: AttendanceReport, sub: string, charts: ChartSpec[]) => void> = {
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

export async function attendanceWorkbook(report: AttendanceReport, view: ExportView, tenant: string, analysis?: ExportAnalysis | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Falaí";
  const charts: ChartSpec[] = [];
  VIEW_SHEET[view](wb, report, subtitleOf(tenant, report.from, report.to), charts);
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
