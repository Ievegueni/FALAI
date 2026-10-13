/**
 * Fila de espera das chamadas de entrada + callback.
 *
 * FILA: quando não há agente livre (todos em chamada, a tocar, em pausa, em
 * pós-chamada ou offline), quem liga fica em espera com música em vez de ouvir
 * "sem serviço". Assim que uma extensão do destino fica livre a chamada toca
 * nela sozinha — ver a secção "Fila" em inboundCallRouter.service.ts, que é
 * dona do estado (em memória, como o IVR).
 *
 * CALLBACK: ao fim de `callbackAfterSecs` na fila toca uma oferta ("prima 1
 * para lhe ligarmos"). Carregar 1 é o consentimento: grava-se um QueueCallback
 * e desliga-se. O despacho abaixo entrega-o ao primeiro agente livre do grupo
 * (CRM aberto, sem pausa, sem chamada, sem pós-chamada) por SSE; o CRM liga
 * pelo webphone e o agente marca o resultado.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { busyExtensionIds } from "./callTyping.service.js";
import { isUserLive } from "./agentTime.service.js";

const DEFAULT_OFFER =
  "Todos os nossos agentes estão ocupados. Para lhe ligarmos de volta assim que houver um agente livre, prima 1. Para continuar à espera, mantenha-se em linha.";
const DEFAULT_THANKS = "Obrigado. Vamos ligar-lhe assim que houver um agente livre.";

export const queueConfigSchema = z.object({
  // 0 = sem fila (comportamento antigo: sem agente livre, "sem serviço").
  maxWaitSecs: z.number().int().min(0).max(3600).default(300),
  callback: z.boolean().default(false),
  callbackAfterSecs: z.number().int().min(10).max(1800).default(60),
  offer: z.string().trim().min(5).max(300).default(DEFAULT_OFFER),
  thanks: z.string().trim().min(2).max(200).default(DEFAULT_THANKS),
});
export type QueueConfig = z.infer<typeof queueConfigSchema>;

export function parseQueueConfig(raw: unknown): QueueConfig {
  const r = queueConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : queueConfigSchema.parse({});
}

export async function tenantQueueConfig(tenantId: string): Promise<QueueConfig> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { queueConfig: true } });
  return parseQueueConfig(t?.queueConfig);
}

/** Áudios da oferta de callback (gerados por TTS ao gravar as definições). */
export const queueOfferPrompt = (tenantId: string) => `queue_cb_${tenantId}`;
export const queueThanksPrompt = (tenantId: string) => `queue_cb_${tenantId}_thanks`;

export async function requestCallback(p: { tenantId: string; callId: string | null; groupId: string | null; number: string }) {
  return prisma.queueCallback.create({ data: p, select: { id: true } });
}

// ─── Despacho ───────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 5 * 60_000; // "não atendeu": volta a tentar daqui a 5 min
const ASSIGN_TIMEOUT_MS = 3 * 60_000; // o agente não fez nada: devolve-se à fila

/** Extensões de quem está a tratar um callback agora — não recebem chamadas da fila. */
export async function callbackBusyExtensionIds(tenantId: string): Promise<Set<string>> {
  const rows = await prisma.queueCallback.findMany({
    where: { tenantId, status: "ASSIGNED" },
    select: { assignedTo: { select: { extensionId: true } } },
  });
  return new Set(rows.map((r) => r.assignedTo?.extensionId).filter((x): x is string => !!x));
}

/**
 * Entrega os callbacks pendentes a agentes livres. `occupied` = extensões em
 * chamada ou a tocar (estado do router); `hasQueue` = o tenant tem chamadas em
 * linha à espera — essas passam à frente dos callbacks.
 * ponytail: chamadas de saída feitas no webphone não contam como "ocupado";
 * o agente que esteja numa recebe o callback na mesma e pode adiá-lo.
 */
export async function dispatchCallbacks(
  fastify: FastifyInstance,
  occupied: Set<string>,
  hasQueue: (tenantId: string) => boolean
): Promise<void> {
  const now = Date.now();
  // Entregues e esquecidos: voltam a pendentes.
  await prisma.queueCallback.updateMany({
    where: { status: "ASSIGNED", assignedAt: { lt: new Date(now - ASSIGN_TIMEOUT_MS) } },
    data: { status: "PENDING", assignedToId: null },
  });
  const pending = await prisma.queueCallback.findMany({
    where: { status: "PENDING", OR: [{ assignedAt: null }, { assignedAt: { lt: new Date(now - RETRY_AFTER_MS) } }] },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const taken = new Set<string>();
  for (const cb of pending) {
    if (hasQueue(cb.tenantId)) continue;
    const users = await prisma.tenantUser.findMany({
      where: {
        tenantId: cb.tenantId,
        extension: {
          isActive: true,
          pausedAt: null,
          ...(cb.groupId && { groups: { some: { groupId: cb.groupId } } }),
        },
        callbacks: { none: { status: "ASSIGNED" } },
      },
      select: { id: true, extensionId: true },
    });
    const exts = users.map((u) => u.extensionId!).filter(Boolean);
    const wrapping = await busyExtensionIds(exts);
    const agent = users.find(
      (u) => !taken.has(u.id) && isUserLive(u.id) && !occupied.has(u.extensionId!) && !wrapping.has(u.extensionId!)
    );
    if (!agent) continue;
    const claimed = await prisma.queueCallback.updateMany({
      where: { id: cb.id, status: "PENDING" },
      data: { status: "ASSIGNED", assignedToId: agent.id, assignedAt: new Date() },
    });
    if (claimed.count === 0) continue;
    taken.add(agent.id);
    fastify.incomingCalls.sendToUsers(cb.tenantId, [agent.id], "queue-callback", await callbackView(cb.id));
  }
}

/** O que o CRM mostra ao agente. */
export async function callbackView(id: string) {
  const cb = await prisma.queueCallback.findUniqueOrThrow({
    where: { id },
    select: { id: true, number: true, status: true, attempts: true, createdAt: true, assignedAt: true, groupId: true, callId: true, assignedTo: { select: { name: true } } },
  });
  const contact = cb.callId
    ? (await prisma.call.findUnique({ where: { id: cb.callId }, select: { contact: { select: { id: true, name: true } } } }))?.contact
    : null;
  return { ...cb, contact: contact ?? null };
}

/** Resultado marcado pelo agente. "NO_ANSWER" volta à fila até MAX_ATTEMPTS. */
export async function closeCallback(id: string, result: "DONE" | "NO_ANSWER" | "CANCELLED") {
  const cb = await prisma.queueCallback.findUniqueOrThrow({ where: { id }, select: { attempts: true } });
  const attempts = cb.attempts + 1;
  const status = result === "NO_ANSWER" ? (attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING") : result;
  return prisma.queueCallback.update({
    where: { id },
    data: {
      status,
      attempts,
      // assignedAt fica: em PENDING serve de "última tentativa" para o intervalo entre tentativas.
      ...(status === "PENDING" ? { assignedToId: null } : { closedAt: new Date() }),
    },
    select: { id: true, status: true, attempts: true },
  });
}
