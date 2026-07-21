import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { ensureCdrSynced, pbxCallStatus } from "./pbxCdr.service.js";

/**
 * Relatório de chamadas por intervalo de datas — unifica os dois produtos:
 *   - VOICE_AI: agrega a tabela Call (inclui entradas kind INBOUND).
 *   - CRM_BYO_PBX: agrega o CDR sincronizado (PbxCall).
 */

export type Direction = "inbound" | "outbound" | "internal";

export interface ReportRow {
  date: Date;
  direction: Direction;
  party: string; // número do interveniente externo
  contactName: string | null;
  status: string;
  outcome: string | null;
  durationSecs: number;
  costCents: number;
}

export interface CallReport {
  from: string;
  to: string;
  totals: {
    total: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    avgDurationSecs: number;
    totalTalkSecs: number;
    costCents: number;
  };
  byDay: { date: string; total: number; answered: number }[];
  byOutcome: { outcome: string; count: number }[];
  byDirection: { direction: Direction; count: number }[];
  sms: { total: number; sent: number; failed: number; costCents: number };
  rows: ReportRow[];
}

const ANSWERED_STATUSES = new Set(["COMPLETED", "ESCALATED"]);

export async function buildCallReport(
  fastify: FastifyInstance,
  tenantId: string,
  range: { from: Date; to: Date }
): Promise<CallReport> {
  const { from, to } = range;
  const { isCrmPbx } = await ensureCdrSynced(fastify, tenantId);

  const [rows, sms] = await Promise.all([
    isCrmPbx ? pbxRows(tenantId, from, to) : voiceRows(tenantId, from, to),
    smsStats(tenantId, from, to),
  ]);

  return { ...summarize(rows, from, to), sms };
}

/** Consumo de SMS do intervalo (para o cliente ver o que gastou). */
async function smsStats(tenantId: string, from: Date, to: Date): Promise<CallReport["sms"]> {
  const rows = await prisma.smsMessage.findMany({
    where: { tenantId, createdAt: { gte: from, lte: to } },
    select: { status: true, costCents: true },
  });
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === "SENT" || r.status === "DELIVERED").length,
    failed: rows.filter((r) => r.status === "FAILED").length,
    costCents: rows.reduce((s, r) => s + r.costCents, 0),
  };
}

async function voiceRows(tenantId: string, from: Date, to: Date): Promise<ReportRow[]> {
  const calls = await prisma.call.findMany({
    where: { tenantId, createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: "desc" },
    select: {
      createdAt: true, kind: true, toNumber: true, fromNumber: true, status: true, outcome: true,
      durationSecs: true, costCents: true, contact: { select: { name: true } },
    },
  });
  return calls.map((c) => {
    const direction: Direction = c.kind === "INBOUND" ? "inbound" : "outbound";
    return {
      date: c.createdAt,
      direction,
      party: direction === "inbound" ? c.fromNumber ?? c.toNumber : c.toNumber,
      contactName: c.contact?.name ?? null,
      status: c.status,
      outcome: c.outcome,
      durationSecs: c.durationSecs,
      costCents: c.costCents,
    };
  });
}

async function pbxRows(tenantId: string, from: Date, to: Date): Promise<ReportRow[]> {
  const calls = await prisma.pbxCall.findMany({
    where: { tenantId, startedAt: { gte: from, lte: to } },
    orderBy: { startedAt: "desc" },
    select: {
      startedAt: true, callType: true, disposition: true, fromNumber: true, toNumber: true,
      talkSecs: true, durationSecs: true,
    },
  });
  return calls.map((c) => {
    const direction: Direction =
      c.callType === "Inbound" ? "inbound" : c.callType === "Internal" ? "internal" : "outbound";
    return {
      date: c.startedAt,
      direction,
      party: direction === "inbound" ? c.fromNumber : c.toNumber,
      contactName: null,
      status: pbxCallStatus(c.disposition),
      outcome: c.disposition,
      durationSecs: c.talkSecs || c.durationSecs,
      costCents: 0,
    };
  });
}

function summarize(rows: ReportRow[], from: Date, to: Date): Omit<CallReport, "sms"> {
  const answered = rows.filter((r) => ANSWERED_STATUSES.has(r.status));
  const inbound = rows.filter((r) => r.direction === "inbound").length;
  const outbound = rows.filter((r) => r.direction === "outbound").length;
  const totalTalkSecs = answered.reduce((s, r) => s + r.durationSecs, 0);
  const costCents = rows.reduce((s, r) => s + r.costCents, 0);

  const byDayMap = new Map<string, { total: number; answered: number }>();
  for (const r of rows) {
    const day = r.date.toISOString().slice(0, 10);
    const b = byDayMap.get(day) ?? { total: 0, answered: 0 };
    b.total++;
    if (ANSWERED_STATUSES.has(r.status)) b.answered++;
    byDayMap.set(day, b);
  }

  const byOutcomeMap = new Map<string, number>();
  for (const r of rows) {
    const key = r.outcome ?? r.status;
    byOutcomeMap.set(key, (byOutcomeMap.get(key) ?? 0) + 1);
  }

  const byDirectionMap = new Map<Direction, number>();
  for (const r of rows) byDirectionMap.set(r.direction, (byDirectionMap.get(r.direction) ?? 0) + 1);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      total: rows.length,
      inbound,
      outbound,
      answered: answered.length,
      missed: rows.length - answered.length,
      avgDurationSecs: answered.length > 0 ? Math.round(totalTalkSecs / answered.length) : 0,
      totalTalkSecs,
      costCents,
    },
    byDay: [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    byOutcome: [...byOutcomeMap.entries()].sort((a, b) => b[1] - a[1]).map(([outcome, count]) => ({ outcome, count })),
    byDirection: [...byDirectionMap.entries()].map(([direction, count]) => ({ direction, count })),
    rows,
  };
}

/** Serializa as linhas do relatório em CSV (com BOM para o Excel abrir UTF-8 correctamente). */
export function reportToCsv(report: CallReport): string {
  const header = ["Data", "Direcao", "Numero", "Contacto", "Estado", "Resultado", "Duracao(s)", "Custo(AOA)"];
  const lines = report.rows.map((r) =>
    [
      r.date.toISOString(),
      r.direction,
      r.party,
      r.contactName ?? "",
      r.status,
      r.outcome ?? "",
      String(r.durationSecs),
      (r.costCents / 100).toFixed(2),
    ]
      .map(csvCell)
      .join(",")
  );
  return "﻿" + [header.join(","), ...lines].join("\r\n");
}

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
