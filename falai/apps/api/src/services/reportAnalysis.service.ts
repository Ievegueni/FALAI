/**
 * Análise dos relatórios com IA (melhoria 6/6).
 *
 * O botão "Analisar com IA" dos Relatórios manda ao Claude APENAS o resumo
 * agregado dos filtros activos (KPIs, contagens, médias, distribuições), com as
 * comparações ao período anterior já calculadas aqui — a IA interpreta, não
 * calcula. Nunca seguem números de telefone, nomes de clientes nem notas; os
 * agentes vão pela extensão, ou pelo nome se o cliente o permitir.
 *
 * Custos: cache por tenant + filtros + dados (o mesmo resumo devolve a análise
 * já feita, sem tokens), limite diário de análises novas por tenant, e tokens/
 * custo gravados em ReportAnalysis.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@falai/db";
import type { ClaudeAdapter } from "@falai/providers";
import type { AttendanceReport, AgentRow } from "./attendanceReport.service.js";
import { deltaPct, type Overview } from "./reportsOverview.service.js";

// ─── Prompt (versionado) ─────────────────────────────────────────────────────

export const PROMPT_VERSION = "report-analysis/v1";

export const SYSTEM_PROMPT = `És um analista de operações de call center. Recebes o RESUMO AGREGADO de um relatório de atendimento (JSON) de uma empresa angolana.

Regras:
- Escreve em português europeu, claro e directo, para um gestor sem formação técnica.
- Interpreta os números que recebes; NÃO recalcules nem inventes valores. Usa as variações (deltaPct, em %) e diferenças (vsTenant, em pontos percentuais ou segundos) que já vêm calculadas.
- "previous" é o período anterior com a mesma duração. Se não houver base de comparação (null), diz isso em vez de comparar.
- Tempos vêm em segundos: apresenta-os como "1 min 20 s".
- Taxas vêm em %. TME = tempo de espera até atender; TMA = tempo médio de conversa.
- Em "signals" vêm sinais já detectados no backend (picos, motivo dominante, tipificações a crescer); usa-os como ponto de partida das anomalias.
- Refere os agentes exactamente pela etiqueta que recebes (ref).
- Se houver poucos dados (ex.: menos de 20 chamadas), avisa que as conclusões são frágeis.
- Recomendações: práticas, concretas e ligadas aos números (máximo 5).
- Responde SEMPRE através da ferramenta report_analysis.`;

// ─── Resultado (JSON validado) ───────────────────────────────────────────────

const who = z.object({ who: z.string().max(120), why: z.string().max(400) });
export const analysisResultSchema = z.object({
  headline: z.string().min(1).max(300),
  summary: z.string().min(1).max(2000),
  comparison: z.string().max(1500),
  anomalies: z.array(z.object({ title: z.string().max(150), detail: z.string().max(500), severity: z.enum(["info", "warning", "critical"]) })).max(8),
  agents: z.object({ above: z.array(who).max(6), below: z.array(who).max(6) }),
  groups: z.object({ above: z.array(who).max(6), below: z.array(who).max(6) }),
  typingTrends: z.array(z.object({ label: z.string().max(150), detail: z.string().max(400) })).max(8),
  recommendations: z.array(z.object({ title: z.string().max(150), detail: z.string().max(500) })).min(1).max(6),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

const str = { type: "string" } as const;
const whoList = { type: "array", items: { type: "object", properties: { who: str, why: str }, required: ["who", "why"] } } as const;
export const ANALYSIS_TOOL = {
  name: "report_analysis",
  description: "Devolve a análise estruturada do relatório.",
  input_schema: {
    type: "object" as const,
    properties: {
      headline: { type: "string", description: "Uma frase com a conclusão principal." },
      summary: { type: "string", description: "Leitura do resumo em linguagem natural (1–2 parágrafos)." },
      comparison: { type: "string", description: "Comparação com o período anterior equivalente." },
      anomalies: {
        type: "array",
        items: {
          type: "object",
          properties: { title: str, detail: str, severity: { type: "string", enum: ["info", "warning", "critical"] } },
          required: ["title", "detail", "severity"],
        },
      },
      agents: { type: "object", properties: { above: whoList, below: whoList }, required: ["above", "below"], description: "Agentes acima/abaixo da média." },
      groups: { type: "object", properties: { above: whoList, below: whoList }, required: ["above", "below"], description: "Grupos acima/abaixo da média." },
      typingTrends: { type: "array", items: { type: "object", properties: { label: str, detail: str }, required: ["label", "detail"] }, description: "Tipificações em crescimento." },
      recommendations: { type: "array", items: { type: "object", properties: { title: str, detail: str }, required: ["title", "detail"] } },
    },
    required: ["headline", "summary", "comparison", "anomalies", "agents", "groups", "typingTrends", "recommendations"],
  },
};

// ─── Resumo enviado à IA (função pura) ───────────────────────────────────────

export interface AnalysisFilters {
  from: string; // AAAA-MM-DD
  to: string;
  extensionId?: string | undefined;
  groupId?: string | undefined;
  categoryId?: string | undefined;
}

export interface PrepareOptions {
  /** Etiquetas dos filtros (nomes de grupo/tipificação; a extensão já anonimizada se for o caso). */
  scope: { agent: string | null; group: string | null; typing: string | null };
  agentNames: boolean;
  /** Supervisor: só as extensões dos grupos dele. undefined = todas. */
  allowedExtensionIds?: Set<string> | undefined;
  /** Totais do cliente (Resumo) — só para quem vê o cliente todo. */
  overview?: Pick<Overview, "tiles" | "daily" | "previousFrom" | "previousTo"> | undefined;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pctDelta = (cur: number | null, prev: number | null) => deltaPct(cur, prev);

export function agentRef(a: Pick<AgentRow, "number" | "name">, names: boolean): string {
  return names && a.name && a.name !== a.number ? `${a.name} (ext. ${a.number})` : `Ext. ${a.number}`;
}

/** Acima/abaixo da média do cliente: ±5 pp na taxa de atendimento ou +5 pp nas recusas. */
export function classify(v: AgentRow["vsTenant"] | { answerRate: number | null }): "above" | "below" | "average" {
  const ar = v.answerRate ?? 0;
  const rr = "rejectRate" in v ? (v.rejectRate ?? 0) : 0;
  if (ar <= -5 || rr >= 5) return "below";
  if (ar >= 5) return "above";
  return "average";
}

export function prepareAnalysisInput(cur: AttendanceReport, prev: AttendanceReport, filters: AnalysisFilters, opts: PrepareOptions) {
  const sc = cur.selection.calls;
  const pc = prev.selection.calls;
  const sa = cur.selection.agents;
  const pa = prev.selection.agents;
  const kpi = <T extends Record<string, number | null>>(c: T, p: T, keys: (keyof T)[]) =>
    Object.fromEntries(keys.map((k) => [k, { current: c[k], previous: p[k], deltaPct: pctDelta(c[k] as number | null, p[k] as number | null) }]));

  const prevAgent = new Map(prev.byAgent.map((a) => [a.extensionId ?? `#${a.number}`, a]));
  const agents = cur.byAgent
    .filter((a) => !opts.allowedExtensionIds || (a.extensionId && opts.allowedExtensionIds.has(a.extensionId)))
    .filter((a) => a.offered > 0)
    .map((a) => {
      const p = prevAgent.get(a.extensionId ?? `#${a.number}`);
      return {
        ref: agentRef(a, opts.agentNames),
        offered: a.offered,
        answered: a.answered,
        rejected: a.rejected,
        answerRate: a.answerRate,
        rejectRate: a.rejectRate,
        tmaSecs: a.tmaSecs,
        responseSecs: a.responseSecs,
        untypedRate: a.untypedRate,
        vsTenant: a.vsTenant,
        previousAnswerRate: p?.answerRate ?? null,
        position: classify(a.vsTenant),
      };
    });

  const prevGroup = new Map(prev.byGroup.map((g) => [g.groupId ?? "", g]));
  const groups = (opts.allowedExtensionIds ? cur.byGroup.filter((g) => g.name === opts.scope.group) : cur.byGroup).map((g) => {
    const p = prevGroup.get(g.groupId ?? "");
    return {
      name: g.name,
      total: g.total,
      answered: g.answered,
      missed: g.missed,
      rejected: g.rejected,
      answerRate: g.answerRate,
      tmeSecs: g.tmeSecs,
      tmaSecs: g.tmaSecs,
      vsTenant: g.vsTenant,
      previousTotal: p?.total ?? null,
      previousAnswerRate: p?.answerRate ?? null,
      position: classify(g.vsTenant),
    };
  });

  const prevReason = new Map(prev.reasons.map((r) => [r.reason, r.count]));
  const rejectReasons = cur.reasons.map((r) => ({
    reason: r.reason,
    count: r.count,
    pct: r.pct,
    previousCount: prevReason.get(r.reason) ?? 0,
    deltaPct: pctDelta(r.count, prevReason.get(r.reason) ?? null),
  }));

  const label = (t: { category: string; subcategory: string | null }) => (t.subcategory ? `${t.category} › ${t.subcategory}` : t.category);
  const prevTyping = new Map(prev.typing.map((t) => [label(t), t.count]));
  const typings = cur.typing.map((t) => {
    const p = prevTyping.get(label(t)) ?? 0;
    return {
      label: label(t),
      count: t.count,
      pct: t.pct,
      previousCount: p,
      deltaPct: pctDelta(t.count, p || null),
      trend: p === 0 ? (t.count > 0 ? "new" : "stable") : t.count >= p * 1.2 && t.count - p >= 3 ? "up" : t.count <= p * 0.8 ? "down" : "stable",
    };
  });

  // Sinais pré-detectados (a IA explica-os; não os procura sozinha).
  const signals: string[] = [];
  const tmeDays = cur.byDay.filter((d) => d.tmeSecs !== null);
  const tmeAvg = tmeDays.length ? tmeDays.reduce((s, d) => s + d.tmeSecs!, 0) / tmeDays.length : null;
  for (const d of tmeDays) if (tmeAvg && tmeDays.length >= 3 && d.tmeSecs! >= tmeAvg * 1.5 && d.tmeSecs! - tmeAvg >= 10) signals.push(`TME alto em ${d.date}: ${d.tmeSecs}s (média do período ${Math.round(tmeAvg)}s)`);
  if (opts.overview) {
    const daily = opts.overview.daily.map((d) => ({ date: d.date, missed: d.total - d.answered }));
    const avg = daily.length ? daily.reduce((s, d) => s + d.missed, 0) / daily.length : 0;
    for (const d of daily) if (daily.length >= 3 && d.missed >= Math.max(avg * 2, avg + 5)) signals.push(`Pico de chamadas não atendidas em ${d.date}: ${d.missed} (média ${round1(avg)}/dia)`);
  }
  const rejDelta = pctDelta(sa.rejected, pa.rejected);
  if (rejDelta !== null && rejDelta >= 25 && sa.rejected >= 5) signals.push(`Recusas a subir: ${sa.rejected} (+${rejDelta}% vs período anterior)`);
  const top = rejectReasons[0];
  if (top && top.pct >= 40 && top.count >= 3) signals.push(`Motivo de recusa dominante: "${top.reason}" (${top.pct}% das recusas)`);
  for (const t of typings.filter((x) => x.trend === "up").slice(0, 3)) signals.push(`Tipificação a crescer: ${t.label} (${t.previousCount} → ${t.count})`);
  const missDelta = pctDelta(sc.missed, pc.missed);
  if (missDelta !== null && missDelta >= 25 && sc.missed >= 5) signals.push(`Não atendidas a subir: ${sc.missed} (+${missDelta}%)`);

  return {
    period: { from: filters.from, to: filters.to, previousFrom: opts.overview?.previousFrom.slice(0, 10) ?? null, previousTo: opts.overview?.previousTo.slice(0, 10) ?? null },
    scope: opts.scope,
    limitedData: cur.limited,
    tenantTotals: opts.overview
      ? opts.overview.tiles.map((t) => ({ key: t.key, unit: t.unit, current: t.value, previous: t.previous, deltaPct: t.deltaPct }))
      : null,
    calls: kpi(sc as unknown as Record<string, number | null>, pc as unknown as Record<string, number | null>, ["total", "answered", "missed", "abandoned", "answerRate", "tmaSecs", "tmeSecs"]),
    agentsTotals: kpi(sa as unknown as Record<string, number | null>, pa as unknown as Record<string, number | null>, ["offered", "answered", "rejected", "answerRate", "rejectRate", "tmaSecs", "responseSecs", "untypedRate"]),
    tenantAverage: { answerRate: cur.tenant.calls.answerRate, tmeSecs: cur.tenant.calls.tmeSecs, agentRejectRate: cur.tenant.agents.rejectRate },
    agents,
    groups,
    rejectReasons,
    typings,
    signals,
  };
}
export type AnalysisInput = ReturnType<typeof prepareAnalysisInput>;

// ─── Cache, limite e custo ───────────────────────────────────────────────────

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export function filtersKey(f: AnalysisFilters): string {
  return sha([f.from, f.to, f.extensionId ?? "", f.groupId ?? "", f.categoryId ?? ""]).slice(0, 32);
}
export const dataHash = (input: AnalysisInput) => sha([PROMPT_VERSION, input]);

/** USD por milhão de tokens (entrada, saída). Desconhecido → preço do Sonnet. */
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-4-6": [3, 15],
  "claude-sonnet-5": [3, 15],
  "claude-opus-5-5": [15, 75],
  "claude-haiku-4-5-20251001": [1, 5],
};
export function costMicroUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [i, o] = PRICES[model] ?? PRICES["claude-sonnet-4-6"]!;
  return Math.round(inputTokens * i + outputTokens * o); // $/Mtok = micro-USD por token
}

export class AnalysisError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Análises novas (não da cache, sem erro) feitas hoje pelo tenant. */
export function usedToday(tenantId: string) {
  // Sucesso = sem erro (tem sempre result); o modo de teste não gasta tokens, não conta.
  return prisma.reportAnalysis.count({ where: { tenantId, createdAt: { gte: startOfToday() }, error: null, model: { not: "stub" } } });
}

/** Última análise com estes filtros (a mostrar no separador e a pôr nas exportações). */
export async function latestAnalysis(tenantId: string, f: AnalysisFilters) {
  const row = await prisma.reportAnalysis.findFirst({
    where: { tenantId, filtersKey: filtersKey(f), error: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true, createdAt: true, model: true, dataHash: true },
  });
  if (!row?.result) return null;
  const parsed = analysisResultSchema.safeParse(row.result);
  return parsed.success ? { id: row.id, result: parsed.data, createdAt: row.createdAt, model: row.model, dataHash: row.dataHash } : null;
}

/** Análise de recurso quando a IA está em modo stub (dev/sem chave): só os sinais. */
export function stubResult(input: AnalysisInput): AnalysisResult {
  const c = input.calls as Record<string, { current: number | null; previous: number | null; deltaPct: number | null }>;
  return {
    headline: `[Modo de teste] ${c["total"]?.current ?? 0} chamadas no período, taxa de atendimento ${c["answerRate"]?.current ?? "—"}%.`,
    summary: "A IA está em modo de teste (sem chave do Claude ou AI_STUB_MODE activo). Esta análise lista apenas os sinais calculados pelo sistema.",
    comparison: `Período anterior: ${c["total"]?.previous ?? 0} chamadas (${c["total"]?.deltaPct ?? "—"}%).`,
    anomalies: input.signals.slice(0, 8).map((s) => ({ title: s.split(":")[0]!.slice(0, 150), detail: s.slice(0, 500), severity: "warning" as const })),
    agents: {
      above: input.agents.filter((a) => a.position === "above").slice(0, 6).map((a) => ({ who: a.ref, why: `Taxa de atendimento ${a.answerRate}%` })),
      below: input.agents.filter((a) => a.position === "below").slice(0, 6).map((a) => ({ who: a.ref, why: `Taxa de atendimento ${a.answerRate}%, recusas ${a.rejectRate}%` })),
    },
    groups: {
      above: input.groups.filter((g) => g.position === "above").slice(0, 6).map((g) => ({ who: g.name, why: `Taxa de atendimento ${g.answerRate}%` })),
      below: input.groups.filter((g) => g.position === "below").slice(0, 6).map((g) => ({ who: g.name, why: `Taxa de atendimento ${g.answerRate}%` })),
    },
    typingTrends: input.typings.filter((t) => t.trend === "up" || t.trend === "new").slice(0, 8).map((t) => ({ label: t.label, detail: `${t.previousCount} → ${t.count}` })),
    recommendations: [{ title: "Configurar a IA", detail: "Defina a chave do Claude no backoffice para obter a análise completa." }],
  };
}

export interface RunAnalysisParams {
  tenantId: string;
  userId: string;
  filters: AnalysisFilters;
  input: AnalysisInput;
  llm: Pick<ClaudeAdapter, "structured">;
  model: string;
  dailyLimit: number;
}

/**
 * Cache → limite → Claude → validação → registo. Devolve a análise e se veio
 * da cache. Erros da IA ficam registados e chegam ao utilizador com mensagem clara.
 */
export async function runAnalysis(p: RunAnalysisParams): Promise<{ analysis: { id: string; result: AnalysisResult; createdAt: Date; model: string }; cached: boolean }> {
  const fKey = filtersKey(p.filters);
  const dHash = dataHash(p.input);

  const hit = await prisma.reportAnalysis.findFirst({
    where: { tenantId: p.tenantId, filtersKey: fKey, dataHash: dHash, error: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true, createdAt: true, model: true },
  });
  const hitParsed = hit?.result ? analysisResultSchema.safeParse(hit.result) : null;
  if (hit && hitParsed?.success) return { analysis: { id: hit.id, result: hitParsed.data, createdAt: hit.createdAt, model: hit.model }, cached: true };

  if ((await usedToday(p.tenantId)) >= p.dailyLimit) {
    throw new AnalysisError(`Atingiu o limite de ${p.dailyLimit} análises com IA por dia. Volte a tentar amanhã ou fale com o suporte.`, 429);
  }

  const base = {
    tenantId: p.tenantId,
    filters: p.filters as object,
    filtersKey: fKey,
    dataHash: dHash,
    promptVersion: PROMPT_VERSION,
    requestedById: p.userId,
  };

  let out: Awaited<ReturnType<RunAnalysisParams["llm"]["structured"]>>;
  try {
    out = await p.llm.structured({
      system: SYSTEM_PROMPT,
      user: `Resumo agregado do relatório (JSON):\n${JSON.stringify(p.input)}`,
      tool: ANALYSIS_TOOL,
      model: p.model,
      maxTokens: 2500,
      timeoutMs: 60_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = /timed? ?out|timeout|ETIMEDOUT|aborted/i.test(msg);
    await prisma.reportAnalysis.create({ data: { ...base, model: p.model, error: msg.slice(0, 500) } });
    throw new AnalysisError(
      timeout ? "A análise com IA demorou demasiado a responder. Tente de novo dentro de momentos." : "O serviço de IA não está disponível de momento. Tente de novo mais tarde.",
      503,
    );
  }

  if (out === null) {
    const result = stubResult(p.input);
    const row = await prisma.reportAnalysis.create({ data: { ...base, model: "stub", result }, select: { id: true, createdAt: true } });
    return { analysis: { id: row.id, result, createdAt: row.createdAt, model: "stub" }, cached: false };
  }

  const parsed = analysisResultSchema.safeParse(out.input);
  const cost = costMicroUsd(out.model, out.inputTokens, out.outputTokens);
  const usage = { model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, costMicroUsd: cost, durationMs: out.durationMs };
  if (!parsed.success) {
    await prisma.reportAnalysis.create({ data: { ...base, ...usage, error: `JSON inválido: ${parsed.error.message.slice(0, 400)}` } });
    throw new AnalysisError("A IA devolveu uma resposta incompleta. Tente de novo.", 502);
  }
  const row = await prisma.reportAnalysis.create({ data: { ...base, ...usage, result: parsed.data }, select: { id: true, createdAt: true } });
  return { analysis: { id: row.id, result: parsed.data, createdAt: row.createdAt, model: out.model }, cached: false };
}

// ─── Exportação (Excel/PDF) ──────────────────────────────────────────────────

const SEVERITY_PT = { info: "Info", warning: "Atenção", critical: "Crítico" } as const;

/** A análise em secções de texto, na ordem do ecrã — usada no Excel e no PDF. */
export function analysisSections(r: AnalysisResult): { title: string; lines: string[] }[] {
  const people = (xs: { who: string; why: string }[]) => xs.map((x) => `${x.who} — ${x.why}`);
  return [
    { title: "Conclusão", lines: [r.headline] },
    { title: "Leitura do resumo", lines: [r.summary] },
    { title: "Comparação com o período anterior", lines: [r.comparison] },
    { title: "Anomalias", lines: r.anomalies.map((a) => `[${SEVERITY_PT[a.severity]}] ${a.title}: ${a.detail}`) },
    { title: "Agentes acima da média", lines: people(r.agents.above) },
    { title: "Agentes abaixo da média", lines: people(r.agents.below) },
    { title: "Grupos acima da média", lines: people(r.groups.above) },
    { title: "Grupos abaixo da média", lines: people(r.groups.below) },
    { title: "Tipificações em crescimento", lines: r.typingTrends.map((t) => `${t.label}: ${t.detail}`) },
    { title: "Recomendações", lines: r.recommendations.map((x, i) => `${i + 1}. ${x.title} — ${x.detail}`) },
  ].filter((s) => s.lines.length > 0 && s.lines.some((l) => l.trim()));
}
