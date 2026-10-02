/**
 * Pernas das chamadas de entrada (CallLeg): uma por extensão a que a chamada
 * tocou. É daqui que saem os relatórios de atendimento por agente e por grupo
 * — quem atendeu, quem recusou, quanto tempo tocou.
 *
 * Cada extensão toca em dois canais ao mesmo tempo (hardphone e webphone, ver
 * inboundCallRouter.service.ts). A perna é da EXTENSÃO: o resultado junta o dos
 * dois canais (ver mergeOutcomes).
 *
 * As escritas são best-effort: um erro aqui nunca pode derrubar a chamada.
 */
import { prisma, type CallLegOutcome } from "@falai/db";
import type { FastifyBaseLogger } from "fastify";

/**
 * Resultado de um canal que caiu antes de alguém atender, pela causa Q.850 do
 * Asterisk. `callerGone` = quem ligou já desligou ou outra perna já atendeu:
 * aí o canal foi desligado por nós e a causa não diz nada sobre o agente.
 */
export function classifyLegCause(cause: number | null, callerGone: boolean): CallLegOutcome {
  if (callerGone) return "CANCELLED";
  switch (cause) {
    case 21: // Call rejected — SIP 603 Decline (botão "Recusar")
      return "REJECTED";
    case 17: // User busy — SIP 486 (em chamada / não incomodar)
      return "BUSY";
    case 18: // No user responding — SIP 408/480
    case 19: // No answer — timeout do originate
    case 16: // Normal clearing sem atendimento: o toque acabou
      return "NO_ANSWER";
    default: // offline, endpoint inexistente, erro de rede…
      return "FAILED";
  }
}

/** Do mais ao menos significativo: o que o agente fez pesa mais do que a rede. */
const PRIORITY: CallLegOutcome[] = ["ANSWERED", "REJECTED", "BUSY", "NO_ANSWER", "CANCELLED", "FAILED"];

/**
 * Resultado da extensão a partir dos seus canais. Ex.: webphone offline
 * (FAILED) + hardphone a tocar até ao fim (NO_ANSWER) → NO_ANSWER.
 */
export function mergeOutcomes(outcomes: CallLegOutcome[]): CallLegOutcome {
  for (const o of PRIORITY) if (outcomes.includes(o)) return o;
  return "FAILED";
}

export interface LegTarget {
  extensionId: string;
  number: string;
}

/** Abre uma perna por extensão. Devolve extensionId → legId (vazio se falhar). */
export async function openLegs(
  params: { tenantId: string; callId: string; groupId: string | null; targets: LegTarget[] },
  log: FastifyBaseLogger
): Promise<Map<string, string>> {
  const ringStartedAt = new Date();
  try {
    const legs = await prisma.$transaction(
      params.targets.map((t) =>
        prisma.callLeg.create({
          data: {
            tenantId: params.tenantId,
            callId: params.callId,
            extensionId: t.extensionId,
            extensionNumber: t.number,
            groupId: params.groupId,
            ringStartedAt,
          },
          select: { id: true, extensionId: true },
        })
      )
    );
    return new Map(legs.map((l) => [l.extensionId!, l.id]));
  } catch (err) {
    log.error({ err, callId: params.callId }, "call_legs.open_failed");
    return new Map();
  }
}

/** Fecha uma perna que não atendeu. Não sobrepõe um resultado já gravado. */
export async function endLeg(
  legId: string,
  outcome: CallLegOutcome,
  cause: number | null,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    await prisma.callLeg.updateMany({
      where: { id: legId, outcome: null },
      data: { outcome, hangupCause: cause, endedAt: new Date() },
    });
  } catch (err) {
    log.error({ err, legId }, "call_legs.end_failed");
  }
}

export async function answerLeg(legId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await prisma.callLeg.updateMany({
      where: { id: legId, outcome: null },
      data: { outcome: "ANSWERED", answeredAt: new Date() },
    });
  } catch (err) {
    log.error({ err, legId }, "call_legs.answer_failed");
  }
}

/**
 * Fim da chamada: a perna que atendeu ganha o instante do fim; qualquer perna
 * ainda aberta (evento perdido, reinício) fecha como CANCELLED.
 */
export async function closeLegs(callId: string, endedAt: Date, log: FastifyBaseLogger): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.callLeg.updateMany({
        where: { callId, outcome: "ANSWERED", endedAt: null },
        data: { endedAt },
      }),
      prisma.callLeg.updateMany({
        where: { callId, outcome: null },
        data: { outcome: "CANCELLED", endedAt },
      }),
    ]);
  } catch (err) {
    log.error({ err, callId }, "call_legs.close_failed");
  }
}
