import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@falai/db";
import type { UserScope } from "./userScope.js";

/**
 * Qualidade (centro de atendimento, fase 7) — ver docs/PLANO-CENTRO-ATENDIMENTO.md.
 *
 * Tipos de critério:
 *   yesno      Conforme (YES), Não conforme (NO) ou Não aplicável (NA)
 *   scale      1 a 5, ou NA (1 = 0 %, 5 = 100 %)
 *   auto_form  "ficha preenchida na chamada?" — respondido pelo sistema (YES/NO/NA)
 * Score = média ponderada dos critérios respondidos × 100 (os NA não contam).
 * Um critério eliminatório (critical, só sim/não) em NO põe o score a 0.
 * O score calcula-se sempre aqui, nunca vem do browser.
 */

export const ANSWERS = ["YES", "NO", "NA", "1", "2", "3", "4", "5"] as const;
export type Answer = (typeof ANSWERS)[number];
export const CRITERION_TYPES = ["yesno", "scale", "auto_form"] as const;
export type CriterionType = (typeof CRITERION_TYPES)[number];
const SCALE = new Set(["1", "2", "3", "4", "5"]);

/** A resposta serve para este tipo de critério? Pura. */
export const validAnswer = (type: CriterionType, a: unknown) =>
  a === "NA" || (type === "scale" ? SCALE.has(a as string) : a === "YES" || a === "NO");

const criterionSchema = z.object({
  id: z.string().min(1).max(40).optional(), // os novos recebem id no servidor
  label: z.string().trim().min(1).max(200),
  weight: z.number().int().min(1).max(100).default(1),
  critical: z.boolean().default(false),
  type: z.enum(CRITERION_TYPES).default("yesno"),
});
export const formDefinitionSchema = z.object({
  sections: z
    .array(z.object({ title: z.string().trim().min(1).max(120), criteria: z.array(criterionSchema).min(1).max(50) }))
    .min(1)
    .max(20),
});
export type Criterion = { id: string; label: string; weight: number; critical: boolean; type?: CriterionType };
export type FormDefinition = { sections: { title: string; criteria: Criterion[] }[] };

/** Valida e dá id aos critérios novos (os existentes mantêm o seu, para as respostas baterem certo). */
export function normalizeDefinition(input: unknown): FormDefinition {
  const def = formDefinitionSchema.parse(input);
  const seen = new Set<string>();
  return {
    sections: def.sections.map((s) => ({
      title: s.title,
      criteria: s.criteria.map((c) => {
        let id = c.id ?? randomUUID().slice(0, 8);
        while (seen.has(id)) id = randomUUID().slice(0, 8);
        seen.add(id);
        // Na escala não há "falhou": eliminatório só faz sentido em sim/não.
        return { id, label: c.label, weight: c.weight, critical: c.type === "scale" ? false : c.critical, type: c.type };
      }),
    })),
  };
}

export class QaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Quanto vale uma resposta, de 0 a 1 (null = não aplicável). Pura. */
export function answerValue(a: unknown): number | null {
  if (a === "YES") return 1;
  if (a === "NO") return 0;
  if (typeof a === "string" && SCALE.has(a)) return (Number(a) - 1) / 4;
  return null;
}

/** Score de uma avaliação. Pura. Todos os critérios têm de ter resposta válida para o seu tipo. */
export function scoreEvaluation(def: FormDefinition, answers: Record<string, unknown>): { score: number; criticalFail: boolean } {
  const criteria = def.sections.flatMap((s) => s.criteria);
  const missing = criteria.filter((c) => !validAnswer(c.type ?? "yesno", answers[c.id]));
  if (missing.length) throw new QaError(400, `Falta responder a: ${missing.map((c) => c.label).join(", ")}`);
  const criticalFail = criteria.some((c) => c.critical && answers[c.id] === "NO");
  let got = 0;
  let counted = 0;
  for (const c of criteria) {
    const v = answerValue(answers[c.id]);
    if (v === null) continue;
    counted += c.weight;
    got += v * c.weight;
  }
  const score = criticalFail ? 0 : counted ? Math.round((got / counted) * 1000) / 10 : 100;
  return { score, criticalFail };
}

/**
 * Critérios automáticos (auto_form): a ficha foi preenchida nesta chamada?
 * YES se há Call.formData (os obrigatórios já se exigem ao gravar), NO se não
 * há e o cliente tem fichas, NA se não usa fichas ou não é uma chamada.
 * Sobrepõe-se ao que vier do browser ou da IA.
 */
export async function applyAutoCriteria(tenantId: string, def: FormDefinition, answers: Record<string, unknown>, callId: string | null | undefined) {
  const auto = def.sections.flatMap((s) => s.criteria).filter((c) => c.type === "auto_form");
  if (!auto.length) return answers;
  let a: Answer = "NA";
  if (callId) {
    const call = await prisma.call.findFirst({ where: { id: callId, tenantId }, select: { formData: true } });
    if (call?.formData) a = "YES";
    else if (await prisma.contactForm.count({ where: { tenantId, isActive: true } })) a = "NO";
  }
  return { ...answers, ...Object.fromEntries(auto.map((c) => [c.id, a])) };
}

/** Só as respostas dos critérios do formulário (o resto é lixo do pedido). */
export function cleanAnswers(def: FormDefinition, answers: Record<string, unknown>): Record<string, Answer> {
  return Object.fromEntries(def.sections.flatMap((s) => s.criteria).map((c) => [c.id, answers[c.id] as Answer]));
}

/**
 * Quem é o agente desta interacção: na chamada, quem atendeu (ou de que
 * extensão saiu a chamada directa); na conversa e no ticket, o responsável.
 */
export async function agentOf(tenantId: string, ref: { callId?: string | undefined; conversationId?: string | undefined; ticketId?: string | undefined }): Promise<string | null> {
  if (ref.callId) {
    const call = await prisma.call.findFirst({
      where: { id: ref.callId, tenantId },
      select: { kind: true, fromNumber: true, legs: { where: { outcome: "ANSWERED" }, take: 1, select: { extensionId: true } } },
    });
    if (!call) throw new QaError(404, "Chamada não encontrada");
    const extensionId =
      call.legs[0]?.extensionId ??
      (call.kind === "DIRECT" && call.fromNumber
        ? (await prisma.extension.findFirst({ where: { tenantId, number: call.fromNumber }, select: { id: true } }))?.id
        : null);
    if (!extensionId) return null;
    return (await prisma.tenantUser.findFirst({ where: { tenantId, extensionId }, select: { id: true } }))?.id ?? null;
  }
  if (ref.conversationId) {
    const c = await prisma.conversation.findFirst({ where: { id: ref.conversationId, tenantId }, select: { assigneeId: true } });
    if (!c) throw new QaError(404, "Conversa não encontrada");
    return c.assigneeId;
  }
  if (ref.ticketId) {
    const t = await prisma.ticket.findFirst({ where: { id: ref.ticketId, tenantId }, select: { assigneeId: true } });
    if (!t) throw new QaError(404, "Ticket não encontrado");
    return t.assigneeId;
  }
  return null;
}

/**
 * Amostra para avaliar: por agente do âmbito, até `perAgent` chamadas
 * atendidas nos últimos `days` dias, ao acaso, ainda sem avaliação.
 * ponytail: baralha até 200 chamadas por agente em memória — passar a
 * TABLESAMPLE se um agente tiver milhares por semana.
 */
export async function qaSample(tenantId: string, scope: UserScope, days: number, perAgent: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const agents = await prisma.tenantUser.findMany({
    where: {
      tenantId,
      extensionId: { not: null },
      role: { in: ["MEMBER", "SUPERVISOR"] },
      ...(scope.kind === "TEAM" && { id: { in: scope.userIds.filter((id) => id !== scope.userId) } }),
    },
    select: { id: true, name: true, extensionId: true },
  });
  const out: { agentId: string; agent: string; calls: { id: string; at: Date; fromNumber: string | null; durationSecs: number }[] }[] = [];
  for (const a of agents) {
    const calls = await prisma.call.findMany({
      where: {
        tenantId,
        createdAt: { gte: since },
        legs: { some: { extensionId: a.extensionId!, outcome: "ANSWERED" } },
        endedAt: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, createdAt: true, fromNumber: true, durationSecs: true },
    });
    const done = new Set(
      (await prisma.qaEvaluation.findMany({ where: { tenantId, callId: { in: calls.map((c) => c.id) } }, select: { callId: true } })).map((e) => e.callId)
    );
    const pool = calls.filter((c) => !done.has(c.id));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    out.push({ agentId: a.id, agent: a.name, calls: pool.slice(0, perAgent).map((c) => ({ id: c.id, at: c.createdAt, fromNumber: c.fromNumber, durationSecs: c.durationSecs })) });
  }
  return out;
}

/** Por critério (nome + secção, através das grelhas) e por semana (segunda-feira). Pura. */
export function qaReport(rows: { createdAt: Date; score: number; answers: unknown; formSnapshot: unknown }[]) {
  const crit = new Map<string, { section: string; label: string; sum: number; n: number; no: number }>();
  const weeks = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const def = r.formSnapshot as FormDefinition;
    const answers = (r.answers ?? {}) as Record<string, unknown>;
    for (const s of def.sections ?? []) {
      for (const c of s.criteria) {
        const v = answerValue(answers[c.id]);
        if (v === null) continue;
        const k = `${s.title}\u0000${c.label}`;
        const e = crit.get(k) ?? { section: s.title, label: c.label, sum: 0, n: 0, no: 0 };
        e.sum += v;
        e.n += 1;
        if (answers[c.id] === "NO") e.no += 1;
        crit.set(k, e);
      }
    }
    const d = new Date(r.createdAt);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const wk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // local, não UTC
    const w = weeks.get(wk) ?? { sum: 0, n: 0 };
    w.sum += r.score;
    w.n += 1;
    weeks.set(wk, w);
  }
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    byCriterion: [...crit.values()]
      .map((e) => ({ section: e.section, label: e.label, avgPct: round((e.sum / e.n) * 100), answered: e.n, failed: e.no }))
      .sort((a, b) => a.avgPct - b.avgPct),
    weekly: [...weeks.entries()].map(([week, w]) => ({ week, avgScore: round(w.sum / w.n), evaluations: w.n })).sort((a, b) => a.week.localeCompare(b.week)),
  };
}
