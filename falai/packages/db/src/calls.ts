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

/**
 * Chamadas de campanha são automáticas e curtas; se ficarem presas bloqueiam a
 * campanha (e a fila do cliente) até serem fechadas, por isso o prazo é menor.
 */
const CAMPAIGN_IN_PROGRESS_TIMEOUT_MS = 60 * 60 * 1000;

export type ReconcileStaleCallsResult = {
  closed: number;
  ids: string[];
  /** Campanhas que fecharam como DONE por causa desta reconciliação — o caller trata de notificar (webhook). */
  completedCampaigns: Array<{ campaignId: string; tenantId: string; completed: number; failed: number }>;
};

/**
 * Fecha chamadas presas em estados não-terminais há demasiado tempo sem
 * nenhuma actualização — sinal de que o evento de fim (do motor de telefonia
 * ou do callback do frontend) nunca chegou. Ver [[stuck-calls-2026-08-13]].
 */
export async function reconcileStaleCalls(now: Date = new Date()): Promise<ReconcileStaleCallsResult> {
  const dialingCutoff = new Date(now.getTime() - DIALING_TIMEOUT_MS);
  const inProgressCutoff = new Date(now.getTime() - IN_PROGRESS_TIMEOUT_MS);
  const campaignInProgressCutoff = new Date(now.getTime() - CAMPAIGN_IN_PROGRESS_TIMEOUT_MS);

  const stale = await prisma.call.findMany({
    where: {
      OR: [
        { status: { in: ["DIALING", "RINGING"] }, updatedAt: { lt: dialingCutoff } },
        { status: "IN_PROGRESS", campaignId: null, updatedAt: { lt: inProgressCutoff } },
        { status: "IN_PROGRESS", campaignId: { not: null }, updatedAt: { lt: campaignInProgressCutoff } },
      ],
    },
    select: { id: true, campaignId: true },
  });

  if (stale.length === 0) return { closed: 0, ids: [], completedCampaigns: [] };

  const ids = stale.map((c) => c.id);
  await prisma.call.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "FAILED",
      endedAt: now,
      failReason: "Reconciliação automática: sem actualização do motor de telefonia dentro do prazo esperado",
    },
  });

  // Sem isto o CampaignContact ficava para sempre em IN_PROGRESS mesmo com a
  // Call já fechada acima — a campanha nunca via "remaining = 0", ficava presa
  // em RUNNING para sempre e bloqueava a próxima campanha da fila do cliente.
  // Relato do cliente FACIL CREDITO, 2026-09-21 (campanhas cmuau5vnn.../cmuau5xat...).
  const campaignIds = [...new Set(stale.map((c) => c.campaignId).filter((id): id is string => id !== null))];
  const completedCampaigns: ReconcileStaleCallsResult["completedCampaigns"] = [];

  for (const campaignId of campaignIds) {
    const callIdsForCampaign = stale.filter((c) => c.campaignId === campaignId).map((c) => c.id);

    const { count: contactsFixed } = await prisma.campaignContact.updateMany({
      where: { campaignId, callId: { in: callIdsForCampaign }, status: "IN_PROGRESS" },
      data: { status: "FAILED" },
    });

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true, tenantId: true } });
    if (!campaign || campaign.status !== "RUNNING") continue;

    if (contactsFixed > 0) {
      await prisma.campaign.update({ where: { id: campaignId }, data: { failedCount: { increment: contactsFixed } } });
    }

    const remaining = await prisma.campaignContact.count({
      where: { campaignId, status: { in: ["PENDING", "QUEUED", "IN_PROGRESS"] } },
    });

    if (remaining === 0) {
      const [completed, failed] = await Promise.all([
        prisma.campaignContact.count({ where: { campaignId, status: "COMPLETED" } }),
        prisma.campaignContact.count({ where: { campaignId, status: "FAILED" } }),
      ]);
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DONE", completed, failedCount: failed } });
      completedCampaigns.push({ campaignId, tenantId: campaign.tenantId, completed, failed });
    }
  }

  return { closed: ids.length, ids, completedCampaigns };
}
