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
import type { Overview } from "./reportsOverview.service.js";
import type { AttendanceReport, ExportView } from "./attendanceReport.service.js";
import type { ReportRow } from "./reports.service.js";

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
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: "frozen", ySplit: 4 }] });
  ws.columns = columns.map((c) => ({ width: c.width }));

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

function agentsSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string): void {
  addTableSheet(wb, "Por agente", "Atendimento por agente", sub, [
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

function groupsSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string): void {
  addTableSheet(wb, "Por grupo", "Atendimento por grupo", sub, [
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

function reasonsSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string): void {
  addTableSheet(wb, "Motivos de recusa", "Motivos de recusa", sub, [
    { header: "Motivo", width: 34, fmt: "text" },
    { header: "Recusas", width: 10, fmt: "int" },
    { header: "%", width: 9, fmt: "pct" },
  ], a.reasons.map((r) => [r.reason, r.count, r.pct]));
}

function typingSheet(wb: ExcelJS.Workbook, a: AttendanceReport, sub: string): void {
  addTableSheet(wb, "Tipificação", "Chamadas por tipificação", sub, [
    { header: "Categoria", width: 24, fmt: "text" },
    { header: "Subcategoria", width: 24, fmt: "text" },
    { header: "Chamadas", width: 10, fmt: "int" },
    { header: "%", width: 9, fmt: "pct" },
  ], a.typing.map((r) => [r.category, r.subcategory, r.count, r.pct]));
}

const VIEW_SHEET: Record<ExportView, (wb: ExcelJS.Workbook, a: AttendanceReport, sub: string) => void> = {
  agents: agentsSheet,
  groups: groupsSheet,
  reasons: reasonsSheet,
  typing: typingSheet,
};

/** Um separador do atendimento (por agente, por grupo, motivos, tipificação). */
export async function attendanceWorkbook(report: AttendanceReport, view: ExportView, tenant: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Falaí";
  VIEW_SHEET[view](wb, report, subtitleOf(tenant, report.from, report.to));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * O Resumo completo: indicadores com o período anterior e a variação, por dia,
 * repartições, as folhas do atendimento e a lista das chamadas.
 */
export async function overviewWorkbook(o: Overview, rows: ReportRow[], tenant: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Falaí";
  const sub = subtitleOf(tenant, o.from, o.to);

  const ws = addTableSheet(wb, "Resumo", "Resumo de chamadas", `${sub} · comparado com ${fmtDate(o.previousFrom)} – ${fmtDate(o.previousTo)}`, [
    { header: "Indicador", width: 44, fmt: "text" },
    { header: "Período", width: 14, fmt: "text" },
    { header: "Período anterior", width: 16, fmt: "text" },
    { header: "Variação", width: 11, fmt: "pct" },
  ], []);
  // Linha a linha: cada indicador tem o seu formato (contagem ou duração).
  o.tiles.forEach((t, i) => {
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
  addTableSheet(wb, "Repartição", "Repartição das chamadas de entrada", sub, [
    { header: "Dimensão", width: 16, fmt: "text" },
    { header: "Valor", width: 24, fmt: "text" },
    { header: "Chamadas", width: 10, fmt: "int" },
    { header: "%", width: 9, fmt: "pct" },
  ], [...share("Grupo", o.donuts.byGroup), ...share("Estado", o.donuts.byState), ...share("Tipificação", o.donuts.byTyping)]);

  if (!o.limited) {
    agentsSheet(wb, o.attendance, sub);
    groupsSheet(wb, o.attendance, sub);
    reasonsSheet(wb, o.attendance, sub);
    typingSheet(wb, o.attendance, sub);
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

  return Buffer.from(await wb.xlsx.writeBuffer());
}
