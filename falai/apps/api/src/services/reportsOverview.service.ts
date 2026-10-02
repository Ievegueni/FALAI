/**
 * Resumo dos relatórios (painel tipo dashboard): cartões com valor, variação
 * face ao período anterior (mesma duração, imediatamente antes) e tendência
 * diária, mais as repartições em anel. Tudo calculado aqui — o CRM e o PDF
 * (reportsPdf.service.ts) só mostram.
 *
 * Reaproveita os dois relatórios existentes: o de chamadas (reports.service,
 * entradas + saídas, ambos os produtos) e o de atendimento (attendanceReport,
 * TMA/TME/resposta/pós-chamada, grupos, tipificação).
 */
import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { buildCallReport, type CallReport } from "./reports.service.js";
import { buildAttendanceReport, UNTYPED, type AttendanceReport } from "./attendanceReport.service.js";
import { ensureCdrSynced } from "./pbxCdr.service.js";

export type Good = "up" | "down" | "neutral";

export interface Tile {
  key: string;
  value: number | null;
  previous: number | null;
  /** Variação em % face ao período anterior (null sem base de comparação). */
  deltaPct: number | null;
  /** Se subir é bom, mau ou indiferente — decide a cor da variação. */
  good: Good;
  unit: "count" | "secs";
  series: (number | null)[];
}

export interface Slice {
  label: string;
  value: number;
}

export interface Overview {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  limited: boolean;
  tiles: Tile[];
  donuts: { byGroup: Slice[]; byState: Slice[]; byTyping: Slice[] };
  daily: { date: string; total: number; answered: number }[];
  /** Para o PDF: o relatório de atendimento completo do período. */
  attendance: AttendanceReport;
  calls: CallReport;
}

/** Variação percentual com 1 casa; null quando não há base (anterior 0/null). */
export function deltaPct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Período anterior com a mesma duração, a acabar mesmo antes de `from`. */
export function previousRange(from: Date, to: Date): { from: Date; to: Date } {
  const len = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  return { from: new Date(prevTo.getTime() - len), to: prevTo };
}

/**
 * Dia no fuso do servidor (AAAA-MM-DD). Os intervalos dos relatórios são dias
 * locais (resolveRange); contar em UTC deslocava as chamadas da meia-noite e
 * acrescentava um dia vazio no início (Angola é UTC+1).
 */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Dias do intervalo (AAAA-MM-DD, locais), para as séries terem um ponto por dia. */
export function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
  const end = localDay(to);
  while (localDay(d) <= end && out.length < 400) {
    out.push(localDay(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Corta em `max` fatias; o resto junta-se em "Outros" (regra: ≤ 6 segmentos). */
export function topSlices(slices: Slice[], max = 6): Slice[] {
  const sorted = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max) return sorted;
  const rest = sorted.slice(max - 1).reduce((s, x) => s + x.value, 0);
  return [...sorted.slice(0, max - 1), { label: "Outros", value: rest }];
}

export async function buildOverview(fastify: FastifyInstance, tenantId: string, range: { from: Date; to: Date }): Promise<Overview> {
  const prev = previousRange(range.from, range.to);
  const { isCrmPbx } = await ensureCdrSynced(fastify, tenantId);
  const [calls, prevCalls, att, prevAtt, contacts, prevContacts] = await Promise.all([
    buildCallReport(fastify, tenantId, range),
    buildCallReport(fastify, tenantId, prev),
    buildAttendanceReport(tenantId, range, { limited: isCrmPbx }),
    buildAttendanceReport(tenantId, prev, { limited: isCrmPbx }),
    prisma.contact.count({ where: { tenantId, createdAt: { gte: range.from, lte: range.to } } }),
    prisma.contact.count({ where: { tenantId, createdAt: { gte: prev.from, lte: prev.to } } }),
  ]);

  const days = daysBetween(range.from, range.to);
  const callDay = new Map<string, { total: number; inbound: number; outbound: number; answered: number; missed: number }>();
  for (const r of calls.rows) {
    const k = localDay(r.date);
    const b = callDay.get(k) ?? { total: 0, inbound: 0, outbound: 0, answered: 0, missed: 0 };
    b.total++;
    if (r.direction === "inbound") b.inbound++;
    else b.outbound++;
    if (r.status === "COMPLETED" || r.status === "ESCALATED") b.answered++;
    else if (r.status === "NO_ANSWER" || r.status === "BUSY") b.missed++;
    callDay.set(k, b);
  }
  const attDay = new Map(att.byDay.map((d) => [d.date, d]));
  const series = (f: (k: string) => number | null) => days.map(f);
  const count = (k: keyof NonNullable<ReturnType<typeof callDay.get>>) => series((d) => callDay.get(d)?.[k] ?? 0);
  const secs = (k: "tmaSecs" | "tmeSecs" | "responseSecs" | "wrapUpSecs") => series((d) => attDay.get(d)?.[k] ?? null);

  const tile = (key: string, value: number | null, previous: number | null, good: Good, unit: Tile["unit"], s: (number | null)[]): Tile => ({
    key,
    value,
    previous,
    deltaPct: deltaPct(value, previous),
    good,
    unit,
    series: s,
  });

  const c = att.tenant.calls;
  const pc = prevAtt.tenant.calls;
  const a = att.tenant.agents;
  const pa = prevAtt.tenant.agents;
  const tiles: Tile[] = [
    tile("total", calls.totals.total, prevCalls.totals.total, "up", "count", count("total")),
    tile("inbound", calls.totals.inbound, prevCalls.totals.inbound, "up", "count", count("inbound")),
    tile("outbound", calls.totals.outbound, prevCalls.totals.outbound, "up", "count", count("outbound")),
    tile("newContacts", contacts, prevContacts, "up", "count", series(() => null)),
    tile("answered", c.answered, pc.answered, "up", "count", count("answered")),
    tile("missed", c.missed, pc.missed, "down", "count", count("missed")),
    tile("tma", c.tmaSecs, pc.tmaSecs, "neutral", "secs", secs("tmaSecs")),
    tile("tme", c.tmeSecs, pc.tmeSecs, "down", "secs", secs("tmeSecs")),
    tile("response", a.responseSecs, pa.responseSecs, "down", "secs", secs("responseSecs")),
    tile("wrapUp", a.wrapUpSecs, pa.wrapUpSecs, "down", "secs", secs("wrapUpSecs")),
  ];

  const byGroup = topSlices(att.byGroup.map((g) => ({ label: g.groupId ? g.name : "Directas", value: g.total })));
  const byState = [
    { label: "Atendidas", value: c.answered },
    { label: "Não atendidas", value: c.missed - c.abandoned },
    { label: "Abandonadas", value: c.abandoned },
  ].filter((s) => s.value > 0);
  // Por categoria (soma das subcategorias); "Não tipificada" à parte.
  const cat = new Map<string, number>();
  for (const t of att.typing) cat.set(t.category, (cat.get(t.category) ?? 0) + t.count);
  const typed = topSlices([...cat.entries()].filter(([k]) => k !== UNTYPED).map(([label, value]) => ({ label, value })), 5);
  const byTyping = [...typed, ...(cat.get(UNTYPED) ? [{ label: UNTYPED, value: cat.get(UNTYPED)! }] : [])];

  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    previousFrom: prev.from.toISOString(),
    previousTo: prev.to.toISOString(),
    limited: att.limited,
    tiles,
    donuts: { byGroup, byState, byTyping },
    daily: days.map((date) => ({ date, total: callDay.get(date)?.total ?? 0, answered: callDay.get(date)?.answered ?? 0 })),
    attendance: att,
    calls,
  };
}
