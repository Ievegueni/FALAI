import { Queue } from "bullmq";
import { prisma } from "@falai/db";
import { config } from "../config.js";
import { QUEUES, JOBS } from "@falai/shared";

let queue: Queue | null = null;

function getQueue(): Queue {
  queue ??= new Queue(QUEUES.WEBHOOKS_OUT, { connection: { url: config.REDIS_URL } });
  return queue;
}

export interface WebhookEventParams {
  tenantId: string;
  event: string;
  payload: Record<string, unknown>;
  /** Presente apenas para eventos ao nível da chamada — usado em logs de dead-letter. */
  callId?: string;
}

/** Enfileira a entrega de um evento de webhook, se o tenant tiver um webhookUrl configurado. */
export async function enqueueWebhook(params: WebhookEventParams): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: params.tenantId },
    select: { webhookUrl: true },
  });
  if (!tenant?.webhookUrl) return;

  await getQueue().add(
    JOBS.DELIVER_WEBHOOK,
    {
      tenantId: params.tenantId,
      event: params.event,
      payload: params.payload,
      ...(params.callId !== undefined && { callId: params.callId }),
    },
    { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
  );
}
