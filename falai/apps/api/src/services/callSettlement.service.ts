import { prisma } from "@falai/db";
import type { CallStatus } from "@falai/db";
import type { FastifyBaseLogger } from "fastify";

interface RetryPolicy {
  maxAttempts: number;
  retryOn: string[];
  delayMinutes: number;
}

function parseRetryPolicy(raw: unknown): RetryPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p["maxAttempts"] !== "number" || !Array.isArray(p["retryOn"])) return null;
  return {
    maxAttempts: p["maxAttempts"] as number,
    retryOn: p["retryOn"] as string[],
    delayMinutes: typeof p["delayMinutes"] === "number" ? p["delayMinutes"] : 60,
  };
}

/** Resolves a CampaignContact after its call ends, applying retry policy if applicable. */
export async function settleCampaignContact(params: {
  callId: string;
  tenantId: string;
  status: CallStatus;
  log: FastifyBaseLogger;
}): Promise<void> {
  const { callId, log } = params;

  const cc = await prisma.campaignContact.findFirst({
    where: { callId },
    include: {
      campaign: { select: { id: true, retryPolicy: true } },
    },
  });

  if (!cc) return; // Not a campaign call

  const callStatus = params.status;
  const retryPolicy = parseRetryPolicy(cc.campaign.retryPolicy);

  const shouldRetry =
    retryPolicy &&
    cc.attempts < retryPolicy.maxAttempts &&
    retryPolicy.retryOn.includes(callStatus);

  if (shouldRetry) {
    const nextRetryAt = new Date(Date.now() + retryPolicy.delayMinutes * 60 * 1000);
    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: {
        status: "PENDING",
        callId: null,
        nextRetryAt,
      },
    });
    log.info(
      { campaignContactId: cc.id, callId, nextRetryAt, attempts: cc.attempts },
      "settlement.retry_scheduled"
    );
    return;
  }

  const finalStatus: "COMPLETED" | "FAILED" =
    callStatus === "COMPLETED" || callStatus === "ESCALATED" ? "COMPLETED" : "FAILED";

  await prisma.campaignContact.update({ where: { id: cc.id }, data: { status: finalStatus } });
  await prisma.campaign.update({
    where: { id: cc.campaign.id },
    data: finalStatus === "COMPLETED"
      ? { completed: { increment: 1 } }
      : { failedCount: { increment: 1 } },
  });

  log.info({ campaignContactId: cc.id, callId, finalStatus }, "settlement.resolved");
}
