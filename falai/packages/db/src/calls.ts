import { prisma } from "./index.js";

/**
 * Chamadas que não avançam de DIALING/RINGING neste prazo nunca vão avançar —
 * em condições normais isso demora segundos, não minutos.
 */
const DIALING_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * IN_PROGRESS aguenta muito mais tempo: chamadas reais podem durar até dezenas
 * de minutos. Isto só apanha o que ficou mesmo esquecido (ex: chamada directa
 * cujo hangup do frontend nunca chegou).
 */
const IN_PROGRESS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export type ReconcileStaleCallsResult = { closed: number; ids: string[] };

/**
 * Fecha chamadas presas em estados não-terminais há demasiado tempo sem
 * nenhuma actualização — sinal de que o evento de fim (do motor de telefonia
 * ou do callback do frontend) nunca chegou. Ver [[stuck-calls-2026-08-13]].
 */
export async function reconcileStaleCalls(now: Date = new Date()): Promise<ReconcileStaleCallsResult> {
  const dialingCutoff = new Date(now.getTime() - DIALING_TIMEOUT_MS);
  const inProgressCutoff = new Date(now.getTime() - IN_PROGRESS_TIMEOUT_MS);

  const stale = await prisma.call.findMany({
    where: {
      OR: [
        { status: { in: ["DIALING", "RINGING"] }, updatedAt: { lt: dialingCutoff } },
        { status: "IN_PROGRESS", updatedAt: { lt: inProgressCutoff } },
      ],
    },
    select: { id: true },
  });

  if (stale.length === 0) return { closed: 0, ids: [] };

  const ids = stale.map((c) => c.id);
  await prisma.call.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "FAILED",
      endedAt: now,
      failReason: "Reconciliação automática: sem actualização do motor de telefonia dentro do prazo esperado",
    },
  });

  return { closed: ids.length, ids };
}
