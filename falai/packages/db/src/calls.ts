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

  // Chamadas já terminadas mas com reserva por acertar há mais de 10 min (o
  // settle corre logo no fim): cancelada sem evento de fim, settle que falhou.
  const unsettled = await prisma.call.findMany({
    where: {
      reservedCents: { gt: 0 },
      status: { notIn: ["QUEUED", "DIALING", "RINGING", "IN_PROGRESS"] },
      updatedAt: { lt: dialingCutoff },
    },
    select: { id: true },
  });
  for (const c of unsettled) await releaseCallReservation(c.id);

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

  // A sessão que ia acertar o custo morreu com a chamada: devolver a reserva.
  for (const id of ids) await releaseCallReservation(id);

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

/**
 * Devolve ao saldo do cliente a reserva ainda pendente de uma chamada.
 * Atómico: lê e zera `Call.reservedCents` numa só instrução, por isso quem
 * chegar em segundo (settleCall, reconciliação, varrimento no arranque) não
 * encontra nada para devolver. Devolve o valor reembolsado (0 se não havia).
 */
export async function releaseCallReservation(callId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ tenantId: string; amount: number }>>`
      UPDATE "Call" c SET "reservedCents" = 0
      FROM (SELECT id, "reservedCents" AS amount FROM "Call" WHERE id = ${callId} FOR UPDATE) old
      WHERE c.id = old.id AND old.amount > 0
      RETURNING c."tenantId" AS "tenantId", old.amount AS amount
    `;
    const row = rows[0];
    if (!row) return 0;
    await tx.$executeRaw`UPDATE "Tenant" SET "balanceCents" = "balanceCents" + ${row.amount} WHERE id = ${row.tenantId}`;
    return row.amount;
  });
}

/**
 * Arranque da API: as sessões do motor de chamadas vivem só em memória, por
 * isso qualquer chamada com reserva pendente neste momento ficou órfã (a API
 * caiu a meio, ou o settle falhou). Devolve já a reserva; o estado da chamada
 * (e do CampaignContact) continua a ser fechado pelo reconcileStaleCalls. ponytail: assume uma única instância da API; com várias,
 * filtrar por instância antes de varrer.
 */
export async function releaseOrphanReservations(): Promise<{ released: number; ids: string[] }> {
  const orphans = await prisma.call.findMany({ where: { reservedCents: { gt: 0 } }, select: { id: true } });
  const ids = orphans.map((c) => c.id);
  let released = 0;
  for (const id of ids) released += await releaseCallReservation(id);
  return { released, ids };
}
