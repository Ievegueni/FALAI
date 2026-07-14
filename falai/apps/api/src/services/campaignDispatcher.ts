import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import type { TelephonyProvider } from "@falai/providers";
import type { CallEngineService } from "./CallEngineService.js";
import { reserveBalance } from "./billing.service.js";

const DISPATCH_INTERVAL_MS = 30_000; // every 30 seconds

interface ScheduleWindow {
  startHour: number; // 0-23
  endHour: number;
  days?: number[];   // 0=Sun, 1=Mon, ... 6=Sat; undefined = all days
}

function isWithinWindow(schedule: unknown, now: Date): boolean {
  if (!schedule || typeof schedule !== "object") return true;
  const s = schedule as Partial<ScheduleWindow>;
  const hour = now.getHours();
  const day = now.getDay();

  if (s.startHour !== undefined && s.endHour !== undefined) {
    if (hour < s.startHour || hour >= s.endHour) return false;
  }
  if (s.days && !s.days.includes(day)) return false;
  return true;
}

export class CampaignDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private telephony: TelephonyProvider,
    private callEngine: CallEngineService,
    private outboundExtension: string,
    private log: FastifyBaseLogger
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, "dispatcher.tick_error"));
    }, DISPATCH_INTERVAL_MS);
    this.log.info({ intervalMs: DISPATCH_INTERVAL_MS }, "dispatcher.started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();

    const campaigns = await prisma.campaign.findMany({
      where: { status: "RUNNING" },
      include: {
        tenant: { include: { plan: { select: { pricePerMinuteCents: true } } } },
        agent: {
          select: {
            systemPrompt: true,
            ttsVoiceId: true,
            maxCallSeconds: true,
            maxTurnSeconds: true,
            escalationNumber: true,
          },
        },
      },
    });

    for (const campaign of campaigns) {
      await this.processCampaign(campaign, now).catch((err) =>
        this.log.error({ err, campaignId: campaign.id }, "dispatcher.campaign_error")
      );
    }
  }

  private async processCampaign(
    campaign: {
      id: string;
      tenantId: string;
      agentId: string;
      throttlePerMinute: number;
      scheduleJson: unknown;
      retryPolicy: unknown;
      tenant: { balanceCents: number; creditLimitCents: number; maxConcurrent: number; plan: { pricePerMinuteCents: number } };
      agent: { systemPrompt: string; ttsVoiceId: string; maxCallSeconds: number; maxTurnSeconds: number; escalationNumber: string | null };
    },
    now: Date
  ): Promise<void> {
    const { tenant, agent } = campaign;

    // Check schedule window
    if (!isWithinWindow(campaign.scheduleJson, now)) return;

    const estimatedCost = Math.ceil(agent.maxCallSeconds / 60) * tenant.plan.pricePerMinuteCents;

    // Auto-pause if balance insufficient for even one call
    if (tenant.balanceCents + tenant.creditLimitCents < estimatedCost && estimatedCost > 0) {
      await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });
      await prisma.systemEvent.create({
        data: {
          severity: "WARNING",
          source: "dispatcher",
          message: `Campaign ${campaign.id} paused — insufficient balance (tenant ${campaign.tenantId})`,
          payload: { campaignId: campaign.id, tenantId: campaign.tenantId, balanceCents: tenant.balanceCents },
        },
      });
      this.log.warn({ campaignId: campaign.id }, "dispatcher.campaign_paused_low_balance");
      return;
    }

    // Check global concurrency
    const activeCalls = await prisma.call.count({
      where: {
        tenantId: campaign.tenantId,
        status: { in: ["DIALING", "RINGING", "IN_PROGRESS"] },
      },
    });
    if (activeCalls >= tenant.maxConcurrent) return;

    const slotsAvailable = Math.min(
      tenant.maxConcurrent - activeCalls,
      campaign.throttlePerMinute
    );

    // Find pending contacts
    const pendingContacts = await prisma.campaignContact.findMany({
      where: {
        campaignId: campaign.id,
        status: "PENDING",
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        contact: { optedOutAt: null },
      },
      include: { contact: true },
      take: slotsAvailable,
    });

    for (const cc of pendingContacts) {
      await this.dispatchContact(campaign, cc, agent, tenant.plan.pricePerMinuteCents, estimatedCost);
    }

    // Mark campaign DONE if all contacts are settled
    const remaining = await prisma.campaignContact.count({
      where: {
        campaignId: campaign.id,
        status: { in: ["PENDING", "QUEUED", "IN_PROGRESS"] },
      },
    });

    if (remaining === 0) {
      const [completed, failed] = await Promise.all([
        prisma.campaignContact.count({ where: { campaignId: campaign.id, status: "COMPLETED" } }),
        prisma.campaignContact.count({ where: { campaignId: campaign.id, status: "FAILED" } }),
      ]);
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "DONE", completed, failedCount: failed },
      });
      this.log.info({ campaignId: campaign.id, completed, failed }, "dispatcher.campaign_done");
    }
  }

  private async dispatchContact(
    campaign: { id: string; tenantId: string; agentId: string; retryPolicy: unknown },
    cc: { id: string; attempts: number; contact: { id: string; phone: string; attributes: unknown; optedOutAt: Date | null } },
    agent: { systemPrompt: string; ttsVoiceId: string; maxCallSeconds: number; maxTurnSeconds: number; escalationNumber: string | null },
    pricePerMinuteCents: number,
    estimatedCost: number
  ): Promise<void> {
    const { contact } = cc;

    // Double-check opt-out
    if (contact.optedOutAt) {
      await prisma.campaignContact.update({ where: { id: cc.id }, data: { status: "OPTED_OUT" } });
      return;
    }

    // Reserve balance atomically
    const reserved = await reserveBalance(campaign.tenantId, estimatedCost);
    if (!reserved) return;

    try {
      const { providerCallId } = await this.telephony.dial({
        fromExtension: this.outboundExtension,
        to: contact.phone,
        ref: `cmp_${campaign.id}_${contact.id}`,
      });

      const call = await prisma.call.create({
        data: {
          tenantId: campaign.tenantId,
          agentId: campaign.agentId,
          campaignId: campaign.id,
          contactId: contact.id,
          toNumber: contact.phone,
          status: "DIALING",
          yeastarCallId: providerCallId,
          variables: (contact.attributes as object) ?? {},
          startedAt: new Date(),
        },
      });

      await this.callEngine.registerCall({
        callId: call.id,
        agentId: campaign.agentId,
        tenantId: campaign.tenantId,
        toNumber: contact.phone,
        providerCallId,
        systemPrompt: agent.systemPrompt,
        ttsVoiceId: agent.ttsVoiceId,
        variables: (contact.attributes as Record<string, unknown>) ?? {},
        maxCallSeconds: agent.maxCallSeconds,
        maxTurnSeconds: agent.maxTurnSeconds,
        ...(agent.escalationNumber !== null && { escalationNumber: agent.escalationNumber }),
        reservedCents: estimatedCost,
        pricePerMinuteCents,
      });

      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { status: "IN_PROGRESS", callId: call.id, attempts: { increment: 1 } },
      });

      this.log.info({ campaignId: campaign.id, callId: call.id, phone: contact.phone }, "dispatcher.dispatched");
    } catch (err) {
      this.log.error({ err, contactId: contact.id }, "dispatcher.dial_failed");

      // Refund reserved balance
      await prisma.tenant.update({
        where: { id: campaign.tenantId },
        data: { balanceCents: { increment: estimatedCost } },
      });

      // Handle retry or mark as failed
      const retryPolicyRaw = campaign.retryPolicy as Record<string, unknown> | null;
      const maxAttempts = typeof retryPolicyRaw?.["maxAttempts"] === "number" ? retryPolicyRaw["maxAttempts"] : 0;
      const delayMinutes = typeof retryPolicyRaw?.["delayMinutes"] === "number" ? retryPolicyRaw["delayMinutes"] : 60;
      const newAttempts = (cc.attempts ?? 0) + 1;

      if (maxAttempts > 0 && newAttempts < maxAttempts) {
        const nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000);
        await prisma.campaignContact.update({
          where: { id: cc.id },
          data: { status: "PENDING", callId: null, attempts: newAttempts, nextRetryAt },
        });
      } else {
        await prisma.campaignContact.update({
          where: { id: cc.id },
          data: { status: "FAILED", attempts: newAttempts },
        });
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { failedCount: { increment: 1 } },
        });
      }
    }
  }
}
