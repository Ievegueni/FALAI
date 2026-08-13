import type { FastifyBaseLogger } from "fastify";
import { prisma, type BillingMode } from "@falai/db";
import type { TelephonyProvider } from "@falai/providers";
import type { CallEngineService } from "./CallEngineService.js";
import { reserveBalance, computeReservation, effectiveBillingMode, settleCall, type PriceConfig } from "./billing.service.js";
import { resolveOutboundExtension, NoOutboundLineError } from "./outboundExtension.service.js";

const DISPATCH_INTERVAL_MS = 30_000; // every 30 seconds

interface ScheduleWindow {
  /**
   * "NOW" → liga assim que a campanha arranca, sem esperar por janela nenhuma.
   * "WINDOW" (ou ausente, por compatibilidade) → respeita hora e dias.
   */
  mode?: "NOW" | "WINDOW";
  startHour: number; // 0-23
  endHour: number;
  /** 0=Dom, 1=Seg, ... 6=Sáb. Ausente = todos os dias. */
  daysOfWeek?: number[];
  /** Aceite por compatibilidade com campanhas antigas. */
  days?: number[];
  timezone?: string;
}

/** Hora e dia da semana no fuso da campanha (por omissão, Luanda). */
function localParts(now: Date, timezone: string): { hour: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? now.getHours());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days.indexOf(weekday);
  return { hour: hour % 24, day: day >= 0 ? day : now.getDay() };
}

function isWithinWindow(schedule: unknown, now: Date): boolean {
  if (!schedule || typeof schedule !== "object") return true;
  const s = schedule as Partial<ScheduleWindow>;

  // Modo "agora": quem lança a campanha quer que ela ligue já.
  if (s.mode === "NOW") return true;

  // O fuso do servidor não é necessariamente o do cliente. Sem isto, uma janela
  // "08h–18h" era avaliada na hora da máquina onde a API corre.
  const { hour, day } = localParts(now, s.timezone || "Africa/Luanda");

  if (s.startHour !== undefined && s.endHour !== undefined) {
    if (hour < s.startHour || hour >= s.endHour) return false;
  }
  // O CRM envia `daysOfWeek`; o código só lia `days` e por isso a restrição de
  // dias NUNCA se aplicava — uma campanha de dias úteis ligava ao domingo.
  const allowedDays = s.daysOfWeek ?? s.days;
  if (allowedDays && allowedDays.length > 0 && !allowedDays.includes(day)) return false;
  return true;
}

export class CampaignDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private telephony: TelephonyProvider,
    private callEngine: CallEngineService,
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
        tenant: { include: { plan: { select: { billingMode: true, pricePerMinuteCents: true, pricePerCallCents: true } } } },
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
    // Note: agent may be null for FIXED_SCRIPT campaigns

    for (const campaign of campaigns) {
      await this.processCampaign(campaign, now).catch((err) =>
        this.log.error({ err, campaignId: campaign.id }, "dispatcher.campaign_error")
      );
    }
  }

  /** Processa imediatamente uma campanha específica sem esperar pelo próximo tick. */
  async processNow(campaignId: string): Promise<void> {
    const now = new Date();
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, status: "RUNNING" },
      include: {
        tenant: { include: { plan: { select: { billingMode: true, pricePerMinuteCents: true, pricePerCallCents: true } } } },
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
    if (!campaign) return;
    await this.processCampaign(campaign, now).catch((err) =>
      this.log.error({ err, campaignId }, "dispatcher.process_now_error")
    );
  }

  private async processCampaign(
    campaign: {
      id: string;
      tenantId: string;
      agentId: string | null;
      mode: string;
      scriptText: string | null;
      ttsVoiceId: string | null;
      throttlePerMinute: number;
      scheduleJson: unknown;
      retryPolicy: unknown;
      tenant: { balanceCents: number; creditLimitCents: number; maxConcurrent: number; billingModeOverride: BillingMode | null; plan: { billingMode: BillingMode; pricePerMinuteCents: number; pricePerCallCents: number } };
      agent: { systemPrompt: string; ttsVoiceId: string; maxCallSeconds: number; maxTurnSeconds: number; escalationNumber: string | null } | null;
    },
    now: Date
  ): Promise<void> {
    const { tenant, agent } = campaign;

    // Check schedule window
    if (!isWithinWindow(campaign.scheduleJson, now)) return;

    // Resolve a extensão de saída da linha do cliente. Sem linha activa,
    // pausa a campanha (não há por onde marcar as chamadas).
    let fromExtension: string;
    try {
      fromExtension = await resolveOutboundExtension(campaign.tenantId);
    } catch (err) {
      if (err instanceof NoOutboundLineError) {
        await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });
        await prisma.systemEvent.create({
          data: {
            severity: "WARNING",
            source: "dispatcher",
            message: `Campaign ${campaign.id} paused — no active outbound line (tenant ${campaign.tenantId})`,
            payload: { campaignId: campaign.id, tenantId: campaign.tenantId },
          },
        });
        this.log.warn({ campaignId: campaign.id }, "dispatcher.campaign_paused_no_line");
        return;
      }
      throw err;
    }

    const price: PriceConfig = campaign.mode === "FIXED_SCRIPT"
      ? { billingMode: "PER_CALL", pricePerMinuteCents: 0, pricePerCallCents: tenant.plan.pricePerCallCents }
      : {
          billingMode: effectiveBillingMode(tenant.plan.billingMode, tenant.billingModeOverride),
          pricePerMinuteCents: tenant.plan.pricePerMinuteCents,
          pricePerCallCents: tenant.plan.pricePerCallCents,
        };
    const estimatedCost = campaign.mode === "FIXED_SCRIPT"
      ? tenant.plan.pricePerCallCents
      : computeReservation(agent?.maxCallSeconds ?? 300, price);

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
    if (activeCalls >= tenant.maxConcurrent) {
      // Sem este log a campanha ficava "Activa" e parada sem explicação — foi
      // exactamente o que aconteceu com chamadas presas em IN_PROGRESS a
      // ocuparem os slots todos.
      this.log.warn(
        { campaignId: campaign.id, tenantId: campaign.tenantId, activeCalls, maxConcurrent: tenant.maxConcurrent },
        "dispatcher.campaign_waiting_for_slot"
      );
      return;
    }

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

    if (campaign.mode === "FIXED_SCRIPT") {
      let scriptPromptName: string;
      try {
        const voiceId = campaign.ttsVoiceId ?? this.callEngine.audioCache.defaultVoice;
        scriptPromptName = await this.callEngine.audioCache.prepareScriptPrompt(
          campaign.id,
          campaign.scriptText ?? "",
          voiceId
        );
      } catch (err) {
        const failReason = err instanceof Error ? err.message : String(err);
        this.log.error({ err, campaignId: campaign.id, failReason }, "dispatcher.script_tts_failed");
        // Pausa a campanha para evitar retry em loop — o operador terá de corrigir a voz/credenciais TTS
        await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });
        await prisma.systemEvent.create({
          data: {
            severity: "ERROR",
            source: "dispatcher",
            message: `Campaign ${campaign.id} paused — TTS generation failed: ${failReason}`,
            payload: { campaignId: campaign.id, tenantId: campaign.tenantId, failReason },
          },
        });
        return;
      }
      for (const cc of pendingContacts) {
        await this.dispatchFixedScript(campaign, cc, price, estimatedCost, fromExtension, scriptPromptName);
      }
    } else {
      for (const cc of pendingContacts) {
        await this.dispatchContact(campaign, cc, agent!, price, estimatedCost, fromExtension);
      }
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
    campaign: { id: string; tenantId: string; agentId: string | null; retryPolicy: unknown },
    cc: { id: string; attempts: number; contact: { id: string; phone: string; attributes: unknown; optedOutAt: Date | null } },
    agent: { systemPrompt: string; ttsVoiceId: string; maxCallSeconds: number; maxTurnSeconds: number; escalationNumber: string | null },
    price: PriceConfig,
    estimatedCost: number,
    fromExtension: string
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
        fromExtension,
        to: contact.phone,
        ref: `cmp_${campaign.id}_${contact.id}`,
        tenantId: campaign.tenantId,
      });

      const call = await prisma.call.create({
        data: {
          tenantId: campaign.tenantId,
          ...(campaign.agentId && { agentId: campaign.agentId }),
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
        agentId: campaign.agentId ?? "",
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
        billingMode: price.billingMode,
        pricePerMinuteCents: price.pricePerMinuteCents,
        pricePerCallCents: price.pricePerCallCents,
      });

      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { status: "IN_PROGRESS", callId: call.id, attempts: { increment: 1 } },
      });

      this.log.info({ campaignId: campaign.id, callId: call.id, phone: contact.phone }, "dispatcher.dispatched");
    } catch (err) {
      const failReason = err instanceof Error ? err.message : String(err);
      this.log.error({ err, contactId: contact.id, failReason }, "dispatcher.dial_failed");

      // Cria registo FAILED para rastreabilidade do erro
      const now = new Date();
      await prisma.call.create({
        data: {
          tenantId: campaign.tenantId,
          ...(campaign.agentId && { agentId: campaign.agentId }),
          campaignId: campaign.id,
          contactId: contact.id,
          toNumber: contact.phone,
          status: "FAILED",
          failReason,
          variables: (contact.attributes as object) ?? {},
          startedAt: now,
          endedAt: now,
        },
      }).catch(() => {}); // não bloqueia o fluxo de retry

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

  private async dispatchFixedScript(
    campaign: { id: string; tenantId: string; retryPolicy: unknown },
    cc: { id: string; attempts: number; contact: { id: string; phone: string; attributes: unknown; optedOutAt: Date | null } },
    price: PriceConfig,
    estimatedCost: number,
    fromExtension: string,
    scriptPromptName: string
  ): Promise<void> {
    const { contact } = cc;

    if (contact.optedOutAt) {
      await prisma.campaignContact.update({ where: { id: cc.id }, data: { status: "OPTED_OUT" } });
      return;
    }

    const reserved = await reserveBalance(campaign.tenantId, estimatedCost);
    if (!reserved) return;

    const now = new Date();

    try {
      await this.telephony.playPrompt({
        number: contact.phone,
        prompts: [scriptPromptName],
        dialPermission: fromExtension,
        autoAnswer: "no",
        count: 1,
        tenantId: campaign.tenantId,
      });

      // Create a settled call record immediately (fire-and-forget call, no live engine)
      const call = await prisma.call.create({
        data: {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          contactId: contact.id,
          toNumber: contact.phone,
          kind: "FIXED_SCRIPT",
          status: "COMPLETED",
          yeastarCallId: `script_${campaign.id}_${contact.id}`,
          variables: (contact.attributes as object) ?? {},
          startedAt: now,
          answeredAt: now,
          endedAt: now,
          durationSecs: 0,
        },
      });

      // Settle billing (PER_CALL = flat debit from reserved balance)
      await settleCall({
        callId: call.id,
        tenantId: campaign.tenantId,
        billedSecs: 0,
        reservedCents: estimatedCost,
        price,
      });

      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { status: "COMPLETED", callId: call.id, attempts: { increment: 1 } },
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { completed: { increment: 1 } },
      });

      this.log.info({ campaignId: campaign.id, callId: call.id, phone: contact.phone }, "dispatcher.fixed_script_dispatched");
    } catch (err) {
      const failReason = err instanceof Error ? err.message : String(err);
      this.log.error({ err, contactId: contact.id, failReason }, "dispatcher.fixed_script_failed");

      // Cria registo FAILED para rastreabilidade do erro
      const failedNow = new Date();
      await prisma.call.create({
        data: {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          contactId: contact.id,
          toNumber: contact.phone,
          kind: "FIXED_SCRIPT",
          status: "FAILED",
          failReason,
          variables: (contact.attributes as object) ?? {},
          startedAt: failedNow,
          endedAt: failedNow,
        },
      }).catch(() => {});

      await prisma.tenant.update({
        where: { id: campaign.tenantId },
        data: { balanceCents: { increment: estimatedCost } },
      });

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
