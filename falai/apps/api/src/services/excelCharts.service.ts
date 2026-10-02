/**
 * Gráficos NATIVOS do Excel nas folhas exportadas. O exceljs não escreve
 * gráficos, por isso acrescentam-se ao .xlsx que ele gera as partes DrawingML
 * (xl/charts, xl/drawings, relações e content types) com o jszip.
 *
 * São gráficos do próprio Excel, ligados às células da folha (c:f) — editáveis,
 * acompanham alterações aos dados e abrem também no Google Sheets/Numbers
 * (levam os valores em cache para isso).
 *
 * Cores: paleta categórica validada (dataviz), em ordem fixa.
 */
import JSZip from "jszip";

const SERIES = ["2A78D6", "EB6834", "1BAF7A", "EDA100", "E87BA4", "008300"];
const GRID = "E4E3DF";
const INK_2 = "52514E";

export interface ChartSeries {
  name: string;
  /** Referência às células dos valores, ex. `'Por agente'!$D$5:$D$9`. */
  ref: string;
  values: (number | null)[];
}

export interface ChartSpec {
  /** Nome da folha onde o gráfico fica (tal como no exceljs). */
  sheet: string;
  type: "column" | "bar" | "line" | "doughnut";
  title: string;
  catRef: string;
  categories: string[];
  /**
   * As categorias são datas (números no Excel): lêem-se como números e o eixo
   * formata-as (ex. "dd/mm"). Sem isto o Excel mostrava 46268, 46269…
   */
  catDateFmt?: string;
  catValues?: number[];
  series: ChartSeries[];
  /** Formato do eixo / rótulos (ex. "#,##0", "0%", "[h]:mm:ss"). */
  numFmt?: string;
  /** Âncora em células (0-based): canto superior esquerdo e inferior direito. */
  from: { col: number; row: number };
  to: { col: number; row: number };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Coluna 0-based → letra(s) do Excel (0 → A, 26 → AA). */
export function colLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Referência absoluta a um intervalo de uma coluna, ex. `'Por dia'!$B$5:$B$34`. */
export function colRef(sheet: string, col: number, fromRow: number, toRow: number): string {
  const c = colLetter(col);
  return `'${sheet.replace(/'/g, "''")}'!$${c}$${fromRow}:$${c}$${toRow}`;
}

function strCache(values: string[]): string {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache>`;
}

function numCache(values: (number | null)[]): string {
  const pts = values.map((v, i) => (v === null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("");
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

const fill = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
const text = (sz: number, bold = false, color = INK_2) =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${bold ? 1 : 0}">${fill(color)}</a:defRPr></a:pPr><a:endParaRPr lang="pt-PT"/></a:p></c:txPr>`;

function title(t: string): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="pt-PT" sz="1200" b="1">${fill("0B0B0B")}</a:rPr><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
}

function serCommon(s: ChartSeries, i: number, spec: ChartSpec): string {
  return `<c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>`;
}

function catVal(s: ChartSeries, spec: ChartSpec): string {
  const cat = spec.catDateFmt
    ? `<c:numRef><c:f>${esc(spec.catRef)}</c:f>${numCache(spec.catValues ?? []).replace("<c:formatCode>General</c:formatCode>", `<c:formatCode>${esc(spec.catDateFmt)}</c:formatCode>`)}</c:numRef>`
    : `<c:strRef><c:f>${esc(spec.catRef)}</c:f>${strCache(spec.categories)}</c:strRef>`;
  return `<c:cat>${cat}</c:cat><c:val><c:numRef><c:f>${esc(s.ref)}</c:f>${numCache(s.values)}</c:numRef></c:val>`;
}

function axes(spec: ChartSpec, horizontal: boolean): string {
  const fmt = esc(spec.numFmt ?? "#,##0");
  // Barras horizontais: a 1.ª categoria em cima (maxMin) e os valores em baixo.
  return (
    `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="${esc(spec.catDateFmt ?? "General")}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>` +
    `<c:spPr><a:ln w="6350">${fill(GRID)}</a:ln></c:spPr>${text(900)}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "b" : "l"}"/>` +
    `<c:majorGridlines><c:spPr><a:ln w="6350">${fill(GRID)}</a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${fmt}" sourceLinked="0"/>` +
    `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${text(900)}` +
    `<c:crossAx val="5001"/><c:crosses val="${horizontal ? "max" : "autoZero"}"/><c:crossBetween val="between"/></c:valAx>`
  );
}

const legend = (show: boolean, pos = "b") => (show ? `<c:legend><c:legendPos val="${pos}"/><c:overlay val="0"/>${text(900)}</c:legend>` : "");

export function chartXml(spec: ChartSpec): string {
  let plot: string;
  const many = spec.series.length > 1;
  if (spec.type === "doughnut") {
    const s = spec.series[0]!;
    const dpts = spec.categories
      .map((_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${fill(SERIES[i % SERIES.length]!)}<a:ln w="19050">${fill("FFFFFF")}</a:ln></c:spPr></c:dPt>`)
      .join("");
    // Percentagem em cada fatia + legenda com o nome: nunca só cor.
    const lbls = `<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${text(900, true, "FFFFFF")}<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>`;
    plot = `<c:doughnutChart><c:varyColors val="1"/><c:ser>${serCommon(s, 0, spec)}${dpts}${lbls}${catVal(s, spec)}</c:ser><c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart>`;
    return wrap(spec, plot, legend(true, "r"));
  }
  if (spec.type === "line") {
    const sers = spec.series
      .map((s, i) => `<c:ser>${serCommon(s, i, spec)}<c:spPr><a:ln w="22225" cap="rnd">${fill(SERIES[i]!)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>${catVal(s, spec)}<c:smooth val="0"/></c:ser>`)
      .join("");
    plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>${axes(spec, false)}`;
    return wrap(spec, plot, legend(many));
  }
  const horizontal = spec.type === "bar";
  const sers = spec.series
    .map((s, i) => `<c:ser>${serCommon(s, i, spec)}<c:spPr>${fill(SERIES[i]!)}</c:spPr><c:invertIfNegative val="0"/>${catVal(s, spec)}</c:ser>`)
    .join("");
  plot = `<c:barChart><c:barDir val="${horizontal ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${many ? 60 : 80}"/><c:overlap val="${many ? -5 : 0}"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>${axes(spec, horizontal)}`;
  return wrap(spec, plot, legend(many));
}

function wrap(spec: ChartSpec, plot: string, leg: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:roundedCorners val="0"/><c:chart>${title(spec.title)}<c:plotArea><c:layout/>${plot}</c:plotArea>${leg}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr>${fill("FFFFFF")}<a:ln w="6350">${fill(GRID)}</a:ln></c:spPr>${text(1000, false, "0B0B0B")}</c:chartSpace>`
  );
}

function anchor(spec: ChartSpec, idx: number): string {
  return (
    `<xdr:twoCellAnchor editAs="oneCell">` +
    `<xdr:from><xdr:col>${spec.from.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${spec.to.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${idx + 2}" name="${esc(spec.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${idx + 1}"/>` +
    `</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  );
}

/**
 * Acrescenta os gráficos ao .xlsx. `sheetOrder` = nomes das folhas pela ordem
 * em que o exceljs as criou (sheet1.xml, sheet2.xml, …).
 */
export async function addCharts(xlsx: Buffer, sheetOrder: string[], charts: ChartSpec[]): Promise<Buffer> {
  if (charts.length === 0) return xlsx;
  const zip = await JSZip.loadAsync(xlsx);
  let types = await zip.file("[Content_Types].xml")!.async("string");
  const overrides: string[] = [];
  let chartN = 0;
  let drawingN = 0;

  for (const [si, sheet] of sheetOrder.entries()) {
    const mine = charts.filter((c) => c.sheet === sheet);
    if (mine.length === 0) continue;
    const d = ++drawingN;
    const anchors: string[] = [];
    const rels: string[] = [];
    mine.forEach((spec, i) => {
      const n = ++chartN;
      zip.file(`xl/charts/chart${n}.xml`, chartXml(spec));
      overrides.push(`<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
      anchors.push(anchor(spec, i));
      rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${n}.xml"/>`);
    });
    zip.file(
      `xl/drawings/drawing${d}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join("")}</xdr:wsDr>`
    );
    zip.file(
      `xl/drawings/_rels/drawing${d}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`
    );
    overrides.push(`<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);

    // Relação folha → desenho, e o <drawing> na folha (vai no fim, depois do pageSetup).
    const sheetPath = `xl/worksheets/sheet${si + 1}.xml`;
    const relsPath = `xl/worksheets/_rels/sheet${si + 1}.xml.rels`;
    const relId = "rIdFalaiDrawing";
    const relXml = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${d}.xml"/>`;
    const existing = zip.file(relsPath);
    zip.file(
      relsPath,
      existing
        ? (await existing.async("string")).replace("</Relationships>", `${relXml}</Relationships>`)
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relXml}</Relationships>`
    );
    const sheetXml = await zip.file(sheetPath)!.async("string");
    const insertAt = ["<legacyDrawing", "<tableParts", "<extLst", "</worksheet>"].map((t) => sheetXml.indexOf(t)).find((i) => i >= 0)!;
    zip.file(sheetPath, `${sheetXml.slice(0, insertAt)}<drawing r:id="${relId}"/>${sheetXml.slice(insertAt)}`);
  }

  types = types.replace("</Types>", `${overrides.join("")}</Types>`);
  zip.file("[Content_Types].xml", types);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
