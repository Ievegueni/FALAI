import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@falai/db";
import type { UserScope } from "./userScope.js";

/**
 * Qualidade (centro de atendimento, fase 7) — ver docs/PLANO-CENTRO-ATENDIMENTO.md.
 *
 * Cada critério responde-se Conforme (YES), Não conforme (NO) ou Não aplicável (NA).
 *   Score = peso dos YES / peso dos YES+NO × 100 (os NA não contam)
 *   Um critério eliminatório (critical) em NO põe o score a 0.
 * O score calcula-se sempre aqui, nunca vem do browser.
 */

export const ANSWERS = ["YES", "NO", "NA"] as const;
export type Answer = (typeof ANSWERS)[number];

const criterionSchema = z.object({
  id: z.string().min(1).max(40).optional(), // os novos recebem id no servidor
  label: z.string().trim().min(1).max(200),
  weight: z.number().int().min(1).max(100).default(1),
  critical: z.boolean().default(false),
});
export const formDefinitionSchema = z.object({
  sections: z
    .array(z.object({ title: z.string().trim().min(1).max(120), criteria: z.array(criterionSchema).min(1).max(50) }))
    .min(1)
    .max(20),
});
export type FormDefinition = { sections: { title: string; criteria: { id: string; label: string; weight: number; critical: boolean }[] }[] };

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
        return { id, label: c.label, weight: c.weight, critical: c.critical };
      }),
    })),
  };
}

export class QaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Score de uma avaliação. Pura. Todos os critérios têm de ter resposta. */
export function scoreEvaluation(def: FormDefinition, answers: Record<string, unknown>): { score: number; criticalFail: boolean } {
  const criteria = def.sections.flatMap((s) => s.criteria);
  const missing = criteria.filter((c) => !ANSWERS.includes(answers[c.id] as Answer));
  if (missing.length) throw new QaError(400, `Falta responder a: ${missing.map((c) => c.label).join(", ")}`);
  const criticalFail = criteria.some((c) => c.critical && answers[c.id] === "NO");
  let yes = 0;
  let counted = 0;
  for (const c of criteria) {
    if (answers[c.id] === "NA") continue;
    counted += c.weight;
    if (answers[c.id] === "YES") yes += c.weight;
  }
  const score = criticalFail ? 0 : counted ? Math.round((yes / counted) * 1000) / 10 : 100;
  return { score, criticalFail };
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
