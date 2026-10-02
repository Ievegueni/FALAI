/**
 * PDF do Resumo dos relatórios — documento a sério (texto seleccionável,
 * gráficos vectoriais), não uma captura do ecrã. Mostra o mesmo que o painel:
 * cartões com variação face ao período anterior e tendência, anéis por grupo /
 * estado / tipificação, chamadas por dia e as tabelas do atendimento.
 */
import PDFDocument from "pdfkit";
import type { Overview, Slice, Tile } from "./reportsOverview.service.js";

// Paleta categórica validada (dataviz, modo claro) — ordem fixa, nunca ciclada.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const INK = "#0b0b0b";
const INK_2 = "#52514e";
const MUTED = "#8a8985";
const HAIR = "#e4e3df";
const GOOD = "#006300";
const BAD = "#d03b3b";

const TILE_LABEL: Record<string, string> = {
  total: "Total de chamadas",
  inbound: "Recebidas",
  outbound: "Efectuadas",
  newContacts: "Novos contactos",
  answered: "Atendidas",
  missed: "Não atendidas",
  tma: "TMA",
  tme: "TME",
  response: "Tempo de resposta",
  wrapUp: "Pós-chamada",
};
const TILE_SUB: Record<string, string> = {
  tma: "Tempo médio de atendimento",
  tme: "Tempo médio de espera",
  response: "Do toque ao atendimento",
  wrapUp: "Do fim até tipificar",
};

const fmtInt = (n: number) => n.toLocaleString("pt-PT");
export function fmtSecs(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h ${m}min` : r > 0 ? `${m}min ${r}s` : `${m}min`;
}
const fmtValue = (t: Tile) => (t.value === null ? "—" : t.unit === "secs" ? fmtSecs(t.value) : fmtInt(t.value));
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("pt-PT");
const fmtPct = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("pt-PT")}%`);

/** Cor da variação: subir é bom/mau conforme o cartão; "neutral" fica cinzento. */
function deltaColor(t: Tile): string {
  if (t.deltaPct === null || t.deltaPct === 0 || t.good === "neutral") return MUTED;
  const up = t.deltaPct > 0;
  return (t.good === "up") === up ? GOOD : BAD;
}

export function renderOverviewPdf(o: Overview, tenantName: string): Promise<Buffer> {
  // bufferPages: a numeração "página X de N" só se escreve no fim.
  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: `Relatório — ${tenantName}`, Author: "Falaí" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const L = 40;
  const W = doc.page.width - 80;

  // ── Cabeçalho ──
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text("Relatório de chamadas", L, 40);
  doc.font("Helvetica").fontSize(10).fillColor(INK_2).text(tenantName, L, 64);
  doc.text(`Período: ${fmtDate(o.from)} – ${fmtDate(o.to)}   ·   comparado com ${fmtDate(o.previousFrom)} – ${fmtDate(o.previousTo)}`, L, 78);
  doc.fillColor(MUTED).fontSize(8).text(`Gerado em ${new Date().toLocaleString("pt-PT")}`, L, 92);
  if (o.limited) {
    doc.fillColor(BAD).fontSize(8).text("PBX próprio (Yeastar): sem dados por agente, grupo, recusas ou tipificação.", L, 104);
  }

  // ── Cartões (4 por linha) ──
  const cols = 4;
  const gap = 10;
  const tw = (W - gap * (cols - 1)) / cols;
  const th = 74;
  let y = 120;
  o.tiles.forEach((t, i) => {
    const x = L + (i % cols) * (tw + gap);
    const ty = y + Math.floor(i / cols) * (th + gap);
    drawTile(doc, t, x, ty, tw, th, SERIES[i % 4]!);
  });
  y += Math.ceil(o.tiles.length / cols) * (th + gap) + 8;

  // ── Anéis ──
  const dw = (W - gap * 2) / 3;
  const donuts: [string, Slice[]][] = [
    ["Por grupo", o.donuts.byGroup],
    ["Por estado", o.donuts.byState],
    ["Por tipificação", o.donuts.byTyping],
  ];
  let maxH = 0;
  donuts.forEach(([title, slices], i) => {
    maxH = Math.max(maxH, drawDonut(doc, title, slices, L + i * (dw + gap), y, dw));
  });
  y += maxH + 12;

  // ── Chamadas por dia ──
  if (y + 170 > doc.page.height - 50) {
    doc.addPage();
    y = 40;
  }
  drawDaily(doc, o.daily, L, y, W, 150);

  // ── Página 2: tabelas do atendimento ──
  if (!o.limited) {
    doc.addPage();
    let ty = 40;
    ty = table(doc, "Por agente", ["Agente", "Tocou", "Atendeu", "Recusou", "% atend.", "TMA", "Resposta", "% não tipif."], [130, 50, 55, 55, 55, 55, 55, 60],
      o.attendance.byAgent.map((a) => [`${a.number} ${a.name && a.name !== a.number ? a.name : ""}`.trim(), fmtInt(a.offered), fmtInt(a.answered), fmtInt(a.rejected), fmtPct(a.answerRate), fmtSecs(a.tmaSecs), fmtSecs(a.responseSecs), fmtPct(a.untypedRate)]), ty);
    ty = table(doc, "Por grupo", ["Grupo", "Chamadas", "Atendidas", "Perdidas", "Abandonadas", "% atend.", "TMA", "TME"], [130, 55, 55, 55, 65, 50, 55, 50],
      o.attendance.byGroup.map((g) => [g.groupId ? g.name : "Directas", fmtInt(g.total), fmtInt(g.answered), fmtInt(g.missed), fmtInt(g.abandoned), fmtPct(g.answerRate), fmtSecs(g.tmaSecs), fmtSecs(g.tmeSecs)]), ty + 8);
    ty = table(doc, "Motivos de recusa", ["Motivo", "Recusas", "%"], [300, 80, 80],
      o.attendance.reasons.map((r) => [r.reason, fmtInt(r.count), fmtPct(r.pct)]), ty + 8);
    table(doc, "Tipificação", ["Categoria", "Subcategoria", "Chamadas", "%"], [170, 170, 80, 80],
      o.attendance.typing.slice(0, 15).map((r) => [r.category, r.subcategory ?? "", fmtInt(r.count), fmtPct(r.pct)]), ty + 8, 2);
  }

  // Rodapé com numeração.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // senão o texto do rodapé abre uma página nova
    doc.fillColor(MUTED).fontSize(8).text(`Falaí · ${tenantName} · página ${i + 1} de ${range.count}`, L, doc.page.height - 30, { width: W, align: "center", lineBreak: false });
  }
  doc.end();
  return done;
}

function drawTile(doc: PDFKit.PDFDocument, t: Tile, x: number, y: number, w: number, h: number, color: string): void {
  doc.roundedRect(x, y, w, h, 6).lineWidth(0.6).strokeColor(HAIR).stroke();
  doc.fillColor(INK_2).font("Helvetica").fontSize(8).text(TILE_LABEL[t.key] ?? t.key, x + 8, y + 7, { width: w - 16, lineBreak: false });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(fmtValue(t), x + 8, y + 19, { width: w - 16, lineBreak: false });
  const sign = t.deltaPct !== null && t.deltaPct > 0 ? "+" : "";
  const delta = t.deltaPct === null ? "sem comparação" : `${sign}${t.deltaPct.toLocaleString("pt-PT")}% vs período anterior`;
  doc.fillColor(deltaColor(t)).font("Helvetica").fontSize(7).text(delta, x + 8, y + 38, { width: w - 16, lineBreak: false });
  if (TILE_SUB[t.key]) doc.fillColor(MUTED).fontSize(6.5).text(TILE_SUB[t.key]!, x + 8, y + 47, { width: w - 16, lineBreak: false });

  // Tendência: linha fina de 1 série, sem eixos (o valor está em cima).
  const pts = t.series.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length >= 2) {
    const max = Math.max(...pts.map((p) => p[1])) || 1;
    const sx = (i: number) => x + 8 + (i / (t.series.length - 1)) * (w - 16);
    const sy = (v: number) => y + h - 6 - (v / max) * 16;
    doc.moveTo(sx(pts[0]![0]), sy(pts[0]![1]));
    for (const [i, v] of pts.slice(1)) doc.lineTo(sx(i), sy(v));
    doc.lineWidth(1.2).strokeColor(color).lineJoin("round").stroke();
  }
}

/** Anel: ≤ 6 fatias, 2pt de separação branca, legenda com valor e %. Devolve a altura usada. */
function drawDonut(doc: PDFKit.PDFDocument, title: string, slices: Slice[], x: number, y: number, w: number): number {
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(title, x, y, { width: w });
  const total = slices.reduce((s, x2) => s + x2.value, 0);
  const cx = x + w / 2;
  const cy = y + 70;
  const R = 46;
  const r = 28;
  if (total === 0) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("Sem dados", x, cy - 5, { width: w, align: "center" });
    return 130;
  }
  let a0 = -Math.PI / 2;
  slices.forEach((s, i) => {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${(cx + rad * Math.cos(ang)).toFixed(2)} ${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    if (slices.length === 1) {
      doc.circle(cx, cy, R).fillColor(SERIES[0]!).fill();
      doc.circle(cx, cy, r).fillColor("#ffffff").fill();
    } else {
      doc
        .path(`M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`)
        .fillColor(SERIES[i]!)
        .lineWidth(2)
        .strokeColor("#ffffff")
        .fillAndStroke();
    }
    a0 = a1;
  });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(fmtInt(total), cx - 30, cy - 6, { width: 60, align: "center" });

  let ly = cy + R + 10;
  slices.forEach((s, i) => {
    doc.rect(x + 4, ly + 1.5, 6, 6).fillColor(SERIES[i]!).fill();
    doc.fillColor(INK_2).font("Helvetica").fontSize(8).text(s.label, x + 14, ly, { width: w - 80, lineBreak: false, ellipsis: true });
    doc.fillColor(INK).text(`${fmtInt(s.value)} · ${Math.round((s.value / total) * 100)}%`, x + w - 66, ly, { width: 62, align: "right", lineBreak: false });
    ly += 12;
  });
  return ly - y;
}

/** Chamadas por dia: barras finas (total) com as atendidas por cima, um só eixo. */
function drawDaily(doc: PDFKit.PDFDocument, daily: Overview["daily"], x: number, y: number, w: number, h: number): void {
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text("Chamadas por dia", x, y);
  doc.rect(x + w - 150, y + 2, 7, 7).fillColor("#a9c8ef").fill();
  doc.fillColor(INK_2).font("Helvetica").fontSize(8).text("Total", x + w - 140, y + 1);
  doc.rect(x + w - 95, y + 2, 7, 7).fillColor(SERIES[0]!).fill();
  doc.fillColor(INK_2).text("Atendidas", x + w - 85, y + 1);
  const top = y + 20;
  const base = top + h - 20;
  const max = Math.max(1, ...daily.map((d) => d.total));
  // Grelha recessiva: 0, metade, máximo.
  for (const f of [0, 0.5, 1]) {
    const gy = base - f * (h - 30);
    doc.moveTo(x + 24, gy).lineTo(x + w, gy).lineWidth(0.4).strokeColor(HAIR).stroke();
    doc.fillColor(MUTED).fontSize(7).text(fmtInt(Math.round(max * f)), x, gy - 3.5, { width: 20, align: "right" });
  }
  const n = daily.length || 1;
  const slot = (w - 30) / n;
  const bw = Math.max(1.5, Math.min(10, slot - 2));
  daily.forEach((d, i) => {
    const bx = x + 28 + i * slot + (slot - bw) / 2;
    const th = (d.total / max) * (h - 30);
    const ah = (d.answered / max) * (h - 30);
    if (th > 0) doc.rect(bx, base - th, bw, th).fillColor("#a9c8ef").fill();
    if (ah > 0) doc.rect(bx, base - ah, bw, ah).fillColor(SERIES[0]!).fill();
  });
  // Etiquetas de data espaçadas (no máximo ~8).
  const step = Math.max(1, Math.ceil(n / 8));
  daily.forEach((d, i) => {
    if (i % step !== 0) return;
    doc.fillColor(MUTED).fontSize(7).text(d.date.slice(8, 10) + "/" + d.date.slice(5, 7), x + 28 + i * slot - 6, base + 4, { width: slot + 12, lineBreak: false });
  });
}

/** Tabela simples; as primeiras `textCols` colunas são texto (à esquerda), o resto números. */
function table(doc: PDFKit.PDFDocument, title: string, head: string[], widths: number[], rows: string[][], y: number, textCols = 1): number {
  const x = 40;
  if (y + 60 > doc.page.height - 50) {
    doc.addPage();
    y = 40;
  }
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(title, x, y);
  y += 18;
  const drawRow = (cells: string[], bold: boolean, color: string) => {
    let cx = x;
    cells.forEach((c, i) => {
      doc.fillColor(color).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8)
        .text(c, cx + 2, y, { width: widths[i]! - 4, align: i < textCols ? "left" : "right", lineBreak: false, ellipsis: true });
      cx += widths[i]!;
    });
    y += 14;
  };
  drawRow(head, true, INK_2);
  doc.moveTo(x, y - 3).lineTo(x + widths.reduce((a, b) => a + b, 0), y - 3).lineWidth(0.4).strokeColor(HAIR).stroke();
  if (rows.length === 0) drawRow(["Sem dados"], false, MUTED);
  for (const r of rows) {
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 40;
      drawRow(head, true, INK_2);
    }
    drawRow(r, false, INK);
  }
  return y + 6;
}
