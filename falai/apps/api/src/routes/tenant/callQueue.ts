import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@falai/db";
import { isOpsManager, userScope } from "../../services/userScope.js";
import {
  callbackView,
  closeCallback,
  queueConfigSchema,
  queueOfferPrompt,
  queueThanksPrompt,
  tenantQueueConfig,
} from "../../services/callQueue.service.js";

/**
 * Fila de espera e callbacks — ver services/callQueue.service.ts.
 * Definições: gestor/admin. Lista: com o âmbito de quem pede (o agente vê os seus).
 */

const resultSchema = z.object({ result: z.enum(["DONE", "NO_ANSWER", "CANCELLED"]) });
const listSchema = z.object({ status: z.enum(["PENDING", "ASSIGNED", "DONE", "FAILED", "CANCELLED"]).optional() });

export const tenantCallQueueRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  fastify.get("/tenant/queue/settings", { preHandler }, async (request) => tenantQueueConfig(request.tenantUser!.tenantId));

  fastify.put("/tenant/queue/settings", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const cfg = queueConfigSchema.parse(request.body);
    // A oferta e o agradecimento viram áudio agora (TTS), não a meio da chamada.
    if (cfg.callback) {
      try {
        await fastify.callEngine.audioCache.prepareNamedPrompt(queueOfferPrompt(tenantId), cfg.offer);
        await fastify.callEngine.audioCache.prepareNamedPrompt(queueThanksPrompt(tenantId), cfg.thanks);
      } catch (err) {
        fastify.log.error({ err, tenantId }, "queue.tts_failed");
        return reply.status(502).send({ error: "Falhou a geração do áudio da oferta de callback — tente gravar de novo" });
      }
    }
    await prisma.tenant.update({ where: { id: tenantId }, data: { queueConfig: cfg } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, tenantId, action: "tenant.queue.settings_updated", targetType: "Tenant", targetId: tenantId, after: cfg, ip: request.ip });
    return cfg;
  });

  // GET /tenant/queue-callbacks — supervisão: todos (ou os do âmbito); agente: os seus
  fastify.get("/tenant/queue-callbacks", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const { status } = listSchema.parse(request.query);
    const scope = await userScope(request.tenantUser!);
    const where: Prisma.QueueCallbackWhereInput = {
      tenantId,
      ...(status && { status }),
      ...(scope.kind === "SELF" && { assignedToId: scope.userId }),
      ...(scope.kind === "TEAM" && { OR: [{ groupId: { in: scope.groupIds } }, { assignedToId: { in: scope.userIds } }] }),
    };
    const data = await prisma.queueCallback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, number: true, status: true, attempts: true, createdAt: true, assignedAt: true, closedAt: true, groupId: true, assignedTo: { select: { name: true } } },
    });
    return { data };
  });

  // GET /tenant/queue-callbacks/mine — o callback que está entregue a mim agora (o CRM pergunta ao abrir)
  fastify.get("/tenant/queue-callbacks/mine", { preHandler }, async (request) => {
    const { tenantId, sub } = request.tenantUser!;
    const cb = await prisma.queueCallback.findFirst({ where: { tenantId, assignedToId: sub, status: "ASSIGNED" }, select: { id: true } });
    return { data: cb ? await callbackView(cb.id) : null };
  });

  // POST /tenant/queue-callbacks/:id/result — o agente diz como correu
  fastify.post<{ Params: { id: string } }>("/tenant/queue-callbacks/:id/result", { preHandler }, async (request, reply) => {
    const { tenantId, sub, role } = request.tenantUser!;
    const { result } = resultSchema.parse(request.body);
    const cb = await prisma.queueCallback.findFirst({ where: { id: request.params.id, tenantId }, select: { assignedToId: true, status: true } });
    if (!cb) return reply.status(404).send({ error: "Callback não encontrado" });
    if (cb.assignedToId !== sub && !isOpsManager(role)) return reply.status(403).send({ error: "Este callback não é seu" });
    if (cb.status !== "ASSIGNED" && cb.status !== "PENDING") return reply.status(409).send({ error: "Este callback já está fechado" });
    return closeCallback(request.params.id, result);
  });
};
