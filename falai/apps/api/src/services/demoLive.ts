/**
 * Modo demo — SÓ desenvolvimento. Com DEMO_LIVE=1 a supervisão e a TV da sala
 * tratam as chamadas de entrada "demo-*" da BD (scripts/seed-atendimento.ts)
 * como se estivessem a decorrer agora, e todas as extensões como registadas.
 * Serve para apresentar o painel sem Asterisk nem chamadas reais.
 * Ignorado em produção. Apagar este ficheiro (e os 3 usos em
 * routes/tenant/supervision.ts) quando deixar de ser preciso.
 */
import { prisma } from "@falai/db";
import type { ActiveInboundCall } from "./inboundCallRouter.service.js";

export const demoLive = process.env["DEMO_LIVE"] === "1" && process.env["NODE_ENV"] !== "production";

/** Chamadas "demo-*" atendidas e por terminar → em conversa. */
export async function demoActiveCalls(tenantId: string): Promise<ActiveInboundCall[]> {
  if (!demoLive) return [];
  const legs = await prisma.callLeg.findMany({
    where: { tenantId, outcome: "ANSWERED", endedAt: null, call: { status: "IN_PROGRESS", yeastarCallId: { startsWith: "demo-" } } },
    select: { callId: true, extensionId: true, answeredAt: true, call: { select: { groupId: true, yeastarCallId: true } } },
  });
  return legs
    .filter((l) => l.extensionId && l.answeredAt)
    .map((l) => ({
      tenantId,
      callId: l.callId,
      callerChannelId: l.call.yeastarCallId!,
      agentChannelId: `${l.call.yeastarCallId}-agent`,
      bridgeId: `${l.call.yeastarCallId}-bridge`,
      groupId: l.call.groupId,
      agentExtensionId: l.extensionId!,
      answeredAt: l.answeredAt!,
    }));
}

/** Chamadas "demo-*" em espera (a tocar, sem atender nem terminar) → na fila. */
export async function demoQueuedCalls(tenantId: string): Promise<{ callId: string | null; groupId: string | null; since: Date }[]> {
  if (!demoLive) return [];
  const rows = await prisma.call.findMany({
    where: { tenantId, status: "RINGING", answeredAt: null, endedAt: null, queuedAt: { not: null }, yeastarCallId: { startsWith: "demo-" } },
    select: { id: true, groupId: true, queuedAt: true },
  });
  return rows.map((r) => ({ callId: r.id, groupId: r.groupId, since: r.queuedAt! }));
}
