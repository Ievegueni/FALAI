import type { FastifyPluginAsync } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { z } from "zod";
import {
  sendSms,
  getTenantSmsConfig,
  SmsDisabledError,
  SmsNotConfiguredError,
  InsufficientBalanceError,
} from "../../services/sms.service.js";
import { countSegments } from "@falai/providers";
import { prepareRecipients, startCampaign } from "../../services/smsCampaign.service.js";

const sendSchema = z.object({
  to: z.string().min(5, "Número de destino obrigatório"),
  body: z.string().min(1, "Mensagem vazia").max(1000),
  contactId: z.string().optional(),
});

const campaignSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1).max(1000),
  contactIds: z.array(z.string()).optional(),
  throttlePerMinute: z.number().int().min(1).max(600).optional(),
});

export const tenantSmsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/sms/config — estado da configuração de SMS (para a UI saber se pode enviar)
  fastify.get("/tenant/sms/config", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const cfg = await getTenantSmsConfig(tenantId);
    return {
      enabled: cfg.smsEnabled,
      configured: !!cfg.apiKey,
      senderId: cfg.senderId,
      pricePerSegmentCents: cfg.pricePerSegmentCents,
    };
  });

  // GET /tenant/sms — histórico de mensagens
  fastify.get<{ Querystring: { limit?: string; offset?: string; status?: string } }>(
    "/tenant/sms",
    { preHandler },
    async (request) => {
      const { tenantId } = request.tenantUser!;
      const { limit = "50", offset = "0", status } = request.query;
      const where: Prisma.SmsMessageWhereInput = { tenantId };
      if (status) where.status = status as import("@falai/db").SmsStatus;

      const [messages, total] = await Promise.all([
        prisma.smsMessage.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: parseInt(limit, 10),
          skip: parseInt(offset, 10),
          select: {
            id: true, toNumber: true, body: true, segments: true, status: true, costCents: true,
            senderId: true, campaignId: true, failReason: true, createdAt: true,
            contact: { select: { name: true } },
          },
        }),
        prisma.smsMessage.count({ where }),
      ]);
      return { messages, total };
    }
  );

  // POST /tenant/sms/preview — nº de segmentos + custo estimado (sem enviar)
  fastify.post<{ Body: { body?: string } }>("/tenant/sms/preview", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const body = String(request.body?.body ?? "");
    const cfg = await getTenantSmsConfig(tenantId);
    const segments = body ? countSegments(body) : 0;
    return { segments, costCents: segments * cfg.pricePerSegmentCents, chars: body.length };
  });

  // POST /tenant/sms — envia um SMS avulso
  fastify.post("/tenant/sms", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = sendSchema.parse(request.body);
    try {
      const sent = await sendSms(fastify, tenantId, {
        to: body.to,
        body: body.body,
        contactId: body.contactId ?? null,
      });
      if (sent.status === "FAILED") {
        return reply.status(502).send({ error: "Não foi possível enviar o SMS", sms: sent });
      }
      return reply.status(202).send({ sms: sent });
    } catch (err) {
      if (err instanceof SmsDisabledError) return reply.status(403).send({ error: err.message });
      if (err instanceof SmsNotConfiguredError) return reply.status(422).send({ error: err.message });
      if (err instanceof InsufficientBalanceError) return reply.status(402).send({ error: err.message });
      throw err;
    }
  });

  // ── Campanhas de SMS ──────────────────────────────────────────────────────

  // GET /tenant/sms/campaigns — lista
  fastify.get("/tenant/sms/campaigns", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const campaigns = await prisma.smsCampaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, body: true, status: true, totalRecipients: true,
        sentCount: true, failedCount: true, costCents: true, createdAt: true, completedAt: true,
      },
    });
    return { campaigns };
  });

  // GET /tenant/sms/campaigns/:id — detalhe
  fastify.get<{ Params: { id: string } }>("/tenant/sms/campaigns/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const campaign = await prisma.smsCampaign.findFirst({
      where: { id: request.params.id, tenantId },
      select: {
        id: true, name: true, body: true, status: true, totalRecipients: true,
        sentCount: true, failedCount: true, costCents: true, throttlePerMinute: true,
        createdAt: true, startedAt: true, completedAt: true,
      },
    });
    if (!campaign) return reply.status(404).send({ error: "Campanha não encontrada" });
    return { campaign };
  });

  // POST /tenant/sms/campaigns — cria (DRAFT) e prepara destinatários
  fastify.post("/tenant/sms/campaigns", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = campaignSchema.parse(request.body);

    const cfg = await getTenantSmsConfig(tenantId);
    if (!cfg.smsEnabled) return reply.status(403).send({ error: "O plano do cliente não inclui SMS" });
    if (!cfg.apiKey) return reply.status(422).send({ error: "SMS não está configurado para este cliente" });

    const campaign = await prisma.smsCampaign.create({
      data: {
        tenantId,
        name: body.name,
        body: body.body,
        ...(body.throttlePerMinute ? { throttlePerMinute: body.throttlePerMinute } : {}),
      },
      select: { id: true },
    });
    if (body.contactIds && body.contactIds.length > 0) {
      await prepareRecipients(tenantId, campaign.id, body.contactIds);
    }
    return reply.status(201).send({ id: campaign.id });
  });

  // POST /tenant/sms/campaigns/:id/contacts — adiciona destinatários
  fastify.post<{ Params: { id: string }; Body: { contactIds: string[] } }>(
    "/tenant/sms/campaigns/:id/contacts",
    { preHandler },
    async (request, reply) => {
      const { tenantId } = request.tenantUser!;
      const contactIds = request.body?.contactIds ?? [];
      if (contactIds.length === 0) return reply.status(400).send({ error: "Sem contactos" });
      const res = await prepareRecipients(tenantId, request.params.id, contactIds);
      return res;
    }
  );

  // POST /tenant/sms/campaigns/:id/start — inicia o envio
  fastify.post<{ Params: { id: string } }>("/tenant/sms/campaigns/:id/start", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    await startCampaign(fastify, tenantId, request.params.id);
    return reply.status(202).send({ ok: true });
  });

  // POST /tenant/sms/campaigns/:id/cancel — cancela (pára o despacho)
  fastify.post<{ Params: { id: string } }>("/tenant/sms/campaigns/:id/cancel", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    await prisma.smsCampaign.updateMany({
      where: { id: request.params.id, tenantId, status: { in: ["DRAFT", "RUNNING"] } },
      data: { status: "CANCELLED" },
    });
    return { ok: true };
  });
};
