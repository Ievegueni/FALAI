import { Queue } from "bullmq";
import { prisma } from "@falai/db";
import { QUEUES, JOBS } from "@falai/shared";
import { config } from "../config.js";

/**
 * Emissor único de webhooks de saída.
 *
 * Antes só o motor de chamadas enfileirava webhooks (e só `call.ended`), com a
 * fila criada dentro do plugin. Como o dispatcher de campanhas não é um plugin
 * Fastify, não tinha por onde emitir — daí o cliente nunca receber nada sobre o
 * ciclo de vida da campanha. Este módulo centraliza a fila para que qualquer
 * serviço ou rota possa emitir sem depender da instância do Fastify.
 */
export type WebhookEventName =
  | "call.started"
  | "call.ended"
  | "call.failed"
  | "campaign.completed"
  | "campaign.paused";

/** Todos os eventos que o cliente pode receber — exposto na documentação da API. */
export const WEBHOOK_EVENTS: WebhookEventName[] = [
  "call.started",
  "call.ended",
  "call.failed",
  "campaign.completed",
  "campaign.paused",
];

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUES.WEBHOOKS_OUT, { connection: { url: config.REDIS_URL } });
  }
  return queue;
}

export interface EmitWebhookParams {
  tenantId: string;
  event: WebhookEventName;
  /** Corpo em `data` do webhook. `campaignId`/`contactId` devem vir sempre que existirem. */
  payload: Record<string, unknown>;
  /** Usado apenas para rastreio no dead-letter. */
  callId?: string;
}

/**
 * Enfileira a entrega. Não lança: um webhook nunca deve derrubar a chamada ou a
 * campanha que o originou. Falhas de entrega ficam registadas em SystemEvent
 * pelo worker e são visíveis ao cliente em GET /tenant/webhook-events.
 */
export async function emitWebhook(params: EmitWebhookParams): Promise<void> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.tenantId },
      select: { webhookUrl: true },
    });
    if (!tenant?.webhookUrl) return; // cliente não configurou webhook — nada a fazer

    await getQueue().add(
      JOBS.DELIVER_WEBHOOK,
      {
        callId: params.callId ?? null,
        tenantId: params.tenantId,
        event: params.event,
        payload: { tenantId: params.tenantId, ...params.payload },
      },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 } }
    );
  } catch {
    // silencioso por desenho — ver comentário acima
  }
}

/** Dispara sem esperar, para pontos quentes (dial, fim de chamada). */
export function emitWebhookAsync(params: EmitWebhookParams): void {
  void emitWebhook(params);
}
