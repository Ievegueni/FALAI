import type { FastifyPluginAsync } from "fastify";
import { prisma, chargeMonthlyInvoice } from "@falai/db";
import { z } from "zod";
import { hashPassword } from "../../services/auth.service.js";
import { pbxCallStatus } from "../../services/pbxCdr.service.js";
import {
  computeFeatures, sanitizeFeatureOverrides, invalidateTenantFeatures,
  FEATURE_KEYS, FEATURE_LABELS, FEATURE_HINTS, DEFAULT_FEATURES,
} from "../../services/features.js";
import { encryptSecret } from "../../services/crypto.service.js";
import { invalidateTenantSms } from "../../services/sms.service.js";
import { publicApiUrl } from "../tenant/inboxes.js";
import { checkNumber } from "../../services/waPool.service.js";

const lineCreateSchema = z.object({
  name: z.string().min(1).max(100),
  extension: z.string().min(1).max(30),
  phoneNumber: z.string().max(30).optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const lineUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  extension: z.string().min(1).max(30).optional(),
  phoneNumber: z.string().max(30).nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

// Só imagens rasterizadas ou SVG em base64; 256 KB de imagem ≈ 350 KB em base64.
const logoSchema = z.object({
  logoDataUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, "Formato inválido (PNG, JPG, WEBP ou SVG)")
    .max(350_000, "Logo demasiado grande (máx. 256 KB)")
    .nullable(),
});

const featuresSchema = z.object(
  Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean().optional()])) as Record<string, z.ZodOptional<z.ZodBoolean>>,
);

const createSchema = z.object({
  name: z.string().min(2).max(150),
  email: z.string().email(),
  phone: z.string().min(7).max(20),
  nif: z.string().optional(),
  planId: z.string(),
  ownerName: z.string().min(2).max(100),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
  maxConcurrent: z.number().int().min(1).max(50).optional(),
  creditLimitCents: z.number().int().min(0).optional(),
});

const updateSchema = z.object({
  name: z.string().min(2).max(150).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(20).optional(),
  nif: z.string().optional(),
  planId: z.string().optional(),
  maxConcurrent: z.number().int().min(1).max(50).optional(),
  creditLimitCents: z.number().int().min(0).optional(),
  webhookUrl: z.string().url().optional(),
  webhookSecret: z.string().min(16).optional(),
  billingModeOverride: z.enum(["PER_MINUTE", "PER_SECOND", "PER_CALL"]).nullable().optional(),
});

const smsConfigSchema = z.object({
  // apiKey: preenchida = grava nova; "" = remove; undefined = mantém
  apiKey: z.string().optional(),
  senderId: z.string().max(20).optional(),
  priceSegmentCents: z.number().int().min(0).optional(),
});

const adjustBalanceSchema = z.object({
  amountCents: z.number().int(),
  note: z.string().min(3).max(255),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8, "A password deve ter pelo menos 8 caracteres"),
});

const userCreateSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]).optional(),
});

function mapTenant(t: any) {
  return {
    id: t.id,
    name: t.name,
    email: t.email,
    phone: t.phone,
    nif: t.nif ?? null,
    status: t.status,
    balanceCents: t.balanceCents,
    creditLimitCents: t.creditLimitCents,
    webhookUrl: t.webhookUrl ?? null,
    onboardingCompletedAt: null,
    planId: t.planId,
    plan: t.plan
      ? {
          id: t.plan.id ?? t.planId,
          name: t.plan.name,
          billingMode: t.plan.billingMode ?? "PER_MINUTE",
          pricePerMinCents: t.plan.pricePerMinuteCents ?? 0,
          pricePerCallCents: t.plan.pricePerCallCents ?? 0,
          monthlyFeeCents: t.plan.monthlyFeeCents ?? 0,
          maxAgents: t.plan.maxAgents ?? 0,
          maxConcurrentCalls: t.plan.maxConcurrent ?? t.maxConcurrent ?? 1,
          aiAgentsEnabled: t.plan.aiAgentsEnabled ?? true,
          isActive: t.plan.isActive ?? true,
        }
      : null,
    maxConcurrentCalls: t.maxConcurrent,
    billingModeOverride: t.billingModeOverride ?? null,
    // features efectivas (o que o cliente vê) + overrides crus (o que o operador definiu)
    features: computeFeatures({
      overrides: t.features,
      aiAgentsEnabled: t.plan?.aiAgentsEnabled,
      smsEnabled: t.plan?.smsEnabled,
      productType: t.plan?.productType,
    }),
    featureOverrides: (t.features ?? {}) as Record<string, boolean>,
    logoDataUrl: (t as { logoDataUrl?: string | null }).logoDataUrl ?? null,
    ...(t.lines !== undefined && { lines: t.lines }),
    createdAt: t.createdAt,
    _count: t._count,
    users: t.users,
  };
}

export const adminTenantsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/tenants
  fastify.get<{
    Querystring: { status?: string; page?: string; perPage?: string; search?: string; limit?: string; offset?: string; q?: string };
  }>("/", { preHandler }, async (request) => {
    const { status, search, q } = request.query;
    const page = parseInt(request.query.page ?? "1", 10);
    const perPage = parseInt(request.query.perPage ?? request.query.limit ?? "20", 10);
    const skip = (page - 1) * perPage;
    const searchTerm = search ?? q;

    const where = {
      deletedAt: null,
      ...(status && { status: status as any }),
      ...(searchTerm && {
        OR: [
          { name: { contains: searchTerm, mode: "insensitive" as const } },
          { email: { contains: searchTerm, mode: "insensitive" as const } },
        ],
      }),
    };

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where, orderBy: { createdAt: "desc" }, take: perPage, skip,
        include: {
          plan: true,
          _count: { select: { agents: true, calls: true, contacts: true } },
        },
      }),
      prisma.tenant.count({ where }),
    ]);

    return { data: tenants.map(mapTenant), total, page, perPage };
  });

  // POST /admin/tenants
  fastify.post("/", { preHandler }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const admin = request.adminUser!;

    const plan = await prisma.plan.findUnique({ where: { id: body.planId } });
    if (!plan?.isActive) return reply.status(400).send({ error: "Plano inválido ou inactivo" });

    const existingEmail = await prisma.tenantUser.findUnique({ where: { email: body.ownerEmail } });
    if (existingEmail) return reply.status(409).send({ error: "Email de utilizador já registado" });

    const { ownerName, ownerEmail, ownerPassword, nif, maxConcurrent, creditLimitCents, ...coreData } = body;

    const tenant = await prisma.tenant.create({
      data: {
        name: coreData.name, email: coreData.email, phone: coreData.phone, planId: coreData.planId,
        ...(nif !== undefined && { nif }),
        ...(maxConcurrent !== undefined && { maxConcurrent }),
        ...(creditLimitCents !== undefined && { creditLimitCents }),
        users: { create: { name: ownerName, email: ownerEmail, passwordHash: await hashPassword(ownerPassword), role: "OWNER" } },
      },
      include: { plan: true, _count: { select: { agents: true, calls: true, contacts: true } } },
    });

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.created",
      targetType: "Tenant", targetId: tenant.id,
      after: { name: tenant.name, email: tenant.email, planId: body.planId } as object, ip: request.ip,
    });

    return reply.status(201).send(mapTenant(tenant));
  });

  // GET /admin/tenants/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const tenant = await prisma.tenant.findFirst({
      where: { id: request.params.id, deletedAt: null },
      include: {
        plan: true,
        users: { select: { id: true, name: true, email: true, role: true, lastLoginAt: true } },
        lines: { orderBy: { createdAt: "asc" } },
        _count: { select: { agents: true, calls: true, contacts: true } },
      },
    });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });
    return mapTenant(tenant);
  });

  // PATCH /admin/tenants/:id
  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const body = updateSchema.parse(request.body);
    const admin = request.adminUser!;

    const existing = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!existing) return reply.status(404).send({ error: "Tenant não encontrado" });

    invalidateTenantFeatures(request.params.id); // pode mudar de plano
    const tenant = await prisma.tenant.update({
      where: { id: request.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.nif !== undefined && { nif: body.nif }),
        ...(body.planId !== undefined && { planId: body.planId }),
        ...(body.maxConcurrent !== undefined && { maxConcurrent: body.maxConcurrent }),
        ...(body.creditLimitCents !== undefined && { creditLimitCents: body.creditLimitCents }),
        ...(body.webhookUrl !== undefined && { webhookUrl: body.webhookUrl }),
        ...(body.webhookSecret !== undefined && { webhookSecret: body.webhookSecret }),
        ...(body.billingModeOverride !== undefined && { billingModeOverride: body.billingModeOverride }),
      },
      include: { plan: true, _count: { select: { agents: true, calls: true, contacts: true } } },
    });

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.updated",
      targetType: "Tenant", targetId: tenant.id,
      before: existing as unknown as object, after: body as unknown as object, ip: request.ip,
    });

    return mapTenant(tenant);
  });

  // GET /admin/tenants/:id/sms — configuração de SMS do tenant (chave mascarada)
  // Pool WhatsApp do cliente (só leitura: é o cliente que gere os números no CRM).
  fastify.get<{ Params: { id: string } }>("/:id/whatsapp", { preHandler }, async (request, reply) => {
    const tenantId = request.params.id;
    if (!(await prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true } }))) {
      return reply.status(404).send({ error: "Tenant não encontrado" });
    }
    const [numbers, events] = await Promise.all([
      prisma.inbox.findMany({
        where: { tenantId, channel: "WHATSAPP", deletedAt: null },
        orderBy: [{ waPriority: "asc" }, { createdAt: "asc" }],
      }),
      prisma.systemEvent.findMany({
        where: { tenantId, source: "whatsapp-pool" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, severity: true, message: true, createdAt: true },
      }),
    ]);
    return {
      poolUrl: `${publicApiUrl(request)}/public/wa/${tenantId}`,
      // Nunca devolver config inteiro: tem o token e o app secret cifrados.
      numbers: numbers.map((i) => {
        const c = i.config as { displayPhone?: string; verifiedName?: string; phoneNumberId?: string };
        return {
          id: i.id,
          name: i.name,
          displayPhone: c.displayPhone ?? null,
          verifiedName: c.verifiedName ?? null,
          phoneNumberId: c.phoneNumberId ?? null,
          enabled: i.enabled,
          status: i.waStatus,
          priority: i.waPriority,
          failCount: i.waFailCount,
          lastCheckAt: i.waLastCheckAt,
          lastError: i.waLastError,
          statusAt: i.waStatusAt,
          createdAt: i.createdAt,
        };
      }),
      events,
    };
  });

  // Health check pedido pelo suporte. Mesma lógica do automático: se o número
  // estiver comprovadamente em baixo, o failover acontece aqui também.
  fastify.post<{ Params: { id: string }; Body: { inboxId?: string } }>("/:id/whatsapp/check", { preHandler }, async (request, reply) => {
    const tenantId = request.params.id;
    const inboxId = request.body?.inboxId;
    const numbers = await prisma.inbox.findMany({
      where: { tenantId, channel: "WHATSAPP", deletedAt: null, ...(inboxId && { id: inboxId }) },
      select: { id: true },
    });
    if (!numbers.length) return reply.status(404).send({ error: "Número não encontrado" });
    const results = [];
    for (const n of numbers) results.push({ id: n.id, ...(await checkNumber(fastify, n.id)) });
    await fastify.audit({
      actorType: "ADMIN",
      actorId: request.adminUser!.sub,
      tenantId,
      action: "whatsapp.pool.check",
      targetType: "Inbox",
      targetId: inboxId ?? tenantId,
      after: results,
      ip: request.ip,
    });
    return { results };
  });

  fastify.get<{ Params: { id: string } }>("/:id/sms", { preHandler }, async (request, reply) => {
    const t = await prisma.tenant.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: {
        smsApiKey: true, smsSenderId: true, smsPriceSegmentCents: true,
        plan: { select: { smsEnabled: true, pricePerSmsCents: true } },
      },
    });
    if (!t) return reply.status(404).send({ error: "Tenant não encontrado" });
    return {
      enabled: t.plan.smsEnabled,
      senderId: t.smsSenderId,
      apiKeySet: !!t.smsApiKey,
      priceSegmentCents: t.smsPriceSegmentCents,
      planPriceSegmentCents: t.plan.pricePerSmsCents,
    };
  });

  // PUT /admin/tenants/:id/sms — grava credenciais Futurix + preço (por tenant)
  fastify.put<{ Params: { id: string } }>("/:id/sms", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const body = smsConfigSchema.parse(request.body);
    const existing = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: "Tenant não encontrado" });

    await prisma.tenant.update({
      where: { id: request.params.id },
      data: {
        ...(body.senderId !== undefined && { smsSenderId: body.senderId || null }),
        ...(body.priceSegmentCents !== undefined && { smsPriceSegmentCents: body.priceSegmentCents }),
        // Só sobrescreve a chave se vier preenchida (evita apagar ao gravar o formulário)
        ...(body.apiKey ? { smsApiKey: encryptSecret(body.apiKey) } : {}),
        ...(body.apiKey === "" && { smsApiKey: null }),
      },
    });
    invalidateTenantSms(request.params.id);

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.sms_configured",
      targetType: "Tenant", targetId: request.params.id,
      before: null, after: { senderId: body.senderId, priceSegmentCents: body.priceSegmentCents, apiKeyChanged: !!body.apiKey } as object,
      ip: request.ip,
    });
    return { ok: true };
  });

  // POST /admin/tenants/:id/suspend
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>("/:id/suspend", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const existing = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!existing) return reply.status(404).send({ error: "Tenant não encontrado" });
    if (existing.status === "SUSPENDED") return reply.status(400).send({ error: "Tenant já suspenso" });

    await prisma.tenant.update({ where: { id: request.params.id }, data: { status: "SUSPENDED" } });
    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.suspended",
      targetType: "Tenant", targetId: request.params.id,
      before: { status: existing.status } as object, after: { status: "SUSPENDED" } as object, ip: request.ip,
    });
    return { ok: true };
  });

  // POST /admin/tenants/:id/reactivate
  fastify.post<{ Params: { id: string } }>("/:id/reactivate", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const existing = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!existing) return reply.status(404).send({ error: "Tenant não encontrado" });
    if (existing.status === "ACTIVE") return reply.status(400).send({ error: "Tenant já activo" });
    if (existing.status === "CLOSED") return reply.status(400).send({ error: "Tenant encerrado não pode ser reactivado" });

    await prisma.tenant.update({ where: { id: request.params.id }, data: { status: "ACTIVE" } });
    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.reactivated",
      targetType: "Tenant", targetId: request.params.id,
      before: { status: existing.status } as object, after: { status: "ACTIVE" } as object, ip: request.ip,
    });
    return { ok: true };
  });

  // POST /admin/tenants/:id/adjust-balance
  fastify.post<{ Params: { id: string } }>("/:id/adjust-balance", { preHandler }, async (request, reply) => {
    const body = adjustBalanceSchema.parse(request.body);
    const admin = request.adminUser!;

    const tenant = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    const balanceAfterCents = tenant.balanceCents + body.amountCents;
    await prisma.$transaction([
      prisma.tenant.update({ where: { id: request.params.id }, data: { balanceCents: balanceAfterCents } }),
      prisma.walletTransaction.create({
        data: {
          tenantId: request.params.id, type: body.amountCents >= 0 ? "TOPUP" : "ADJUSTMENT",
          amountCents: body.amountCents, balanceAfterCents, note: body.note,
          reference: `admin_adj_${admin.sub}`, createdBy: admin.sub,
        },
      }),
    ]);

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.balance_adjusted",
      targetType: "Tenant", targetId: request.params.id,
      after: { amountCents: body.amountCents, note: body.note } as object, ip: request.ip,
    });

    return { balanceCents: balanceAfterCents };
  });

  // POST /admin/tenants/:id/run-billing — cobra a mensalidade agora (ops/teste)
  fastify.post<{ Params: { id: string } }>("/:id/run-billing", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const tenant = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null } });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    const result = await chargeMonthlyInvoice(request.params.id);

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.billing_run",
      targetType: "Tenant", targetId: request.params.id, after: result as object, ip: request.ip,
    });

    return result;
  });

  // GET /admin/tenants/:id/invoices — histórico de faturas do tenant
  fastify.get<{ Params: { id: string } }>("/:id/invoices", { preHandler }, async (request) => {
    const invoices = await prisma.invoice.findMany({
      where: { tenantId: request.params.id },
      orderBy: { period: "desc" },
      take: 24,
      select: { id: true, period: true, amountCents: true, status: true, issuedAt: true, paidAt: true },
    });
    return { invoices };
  });

  // GET /admin/tenants/:id/calls
  fastify.get<{ Params: { id: string }; Querystring: { page?: string; perPage?: string } }>(
    "/:id/calls", { preHandler }, async (request) => {
      const page = parseInt(request.query.page ?? "1", 10);
      const perPage = parseInt(request.query.perPage ?? "10", 10);
      const skip = (page - 1) * perPage;

      const tenantId = request.params.id;
      const window = skip + perPage;
      const [calls, callTotal, pbxCalls, pbxTotal] = await Promise.all([
        prisma.call.findMany({
          where: { tenantId },
          orderBy: { createdAt: "desc" }, take: window,
          include: { agent: { select: { name: true } }, tenant: { select: { name: true } } },
        }),
        prisma.call.count({ where: { tenantId } }),
        prisma.pbxCall.findMany({
          where: { tenantId }, orderBy: { startedAt: "desc" }, take: window,
          include: { tenant: { select: { name: true } } },
        }),
        prisma.pbxCall.count({ where: { tenantId } }),
      ]);

      const pbxDir: Record<string, string> = { Inbound: "Entrada", Outbound: "Saída", Internal: "Interna" };
      const aiRows = calls.map((c) => ({
        id: c.id, tenantId: c.tenantId, agentId: c.agentId as string | null,
        to: c.toNumber, status: c.status as string, outcome: c.outcome,
        durationSecs: c.durationSecs, costCents: c.costCents, providerCostCents: c.providerCostCents,
        failReason: c.failReason, startedAt: c.startedAt, endedAt: c.endedAt, createdAt: c.createdAt,
        tenant: c.tenant, agent: c.agent,
      }));
      const pbxRows = pbxCalls.map((c) => ({
        id: c.id, tenantId: c.tenantId, agentId: null,
        to: c.callType === "Inbound" ? c.fromNumber : c.toNumber,
        status: pbxCallStatus(c.disposition), outcome: c.disposition,
        durationSecs: c.talkSecs || c.durationSecs, costCents: 0, providerCostCents: 0,
        failReason: null, startedAt: c.startedAt, endedAt: null, createdAt: c.startedAt,
        tenant: c.tenant, agent: { name: pbxDir[c.callType] ?? c.callType },
      }));
      const data = [...aiRows, ...pbxRows]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(skip, skip + perPage);

      return { data, total: callTotal + pbxTotal, page, perPage };
    }
  );

  // GET /admin/tenants/:id/transactions
  fastify.get<{ Params: { id: string }; Querystring: { page?: string; perPage?: string } }>(
    "/:id/transactions", { preHandler }, async (request) => {
      const page = parseInt(request.query.page ?? "1", 10);
      const perPage = parseInt(request.query.perPage ?? "10", 10);
      const skip = (page - 1) * perPage;

      const [txs, total] = await Promise.all([
        prisma.walletTransaction.findMany({
          where: { tenantId: request.params.id },
          orderBy: { createdAt: "desc" }, take: perPage, skip,
          include: { tenant: { select: { name: true } } },
        }),
        prisma.walletTransaction.count({ where: { tenantId: request.params.id } }),
      ]);

      return {
        data: txs.map((t) => ({
          id: t.id, tenantId: t.tenantId, type: t.type,
          amountCents: t.amountCents, balanceAfterCents: t.balanceAfterCents,
          notes: t.note ?? null, createdBy: t.createdBy ?? null,
          createdAt: t.createdAt, tenant: t.tenant,
        })),
        total, page, perPage,
      };
    }
  );

  // ============ LINHAS DE CHAMADAS ============

  // GET /admin/tenants/:id/lines
  fastify.get<{ Params: { id: string } }>("/:id/lines", { preHandler }, async (request, reply) => {
    const tenant = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });
    const lines = await prisma.tenantLine.findMany({ where: { tenantId: request.params.id }, orderBy: { createdAt: "asc" } });
    return { data: lines };
  });

  // POST /admin/tenants/:id/lines
  fastify.post<{ Params: { id: string } }>("/:id/lines", { preHandler }, async (request, reply) => {
    const body = lineCreateSchema.parse(request.body);
    const admin = request.adminUser!;

    const tenant = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    const existingCount = await prisma.tenantLine.count({ where: { tenantId: request.params.id } });
    // Primeira linha do tenant é sempre a default
    const makeDefault = body.isDefault ?? existingCount === 0;

    const line = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.tenantLine.updateMany({ where: { tenantId: request.params.id }, data: { isDefault: false } });
      }
      return tx.tenantLine.create({
        data: {
          tenantId: request.params.id,
          name: body.name,
          extension: body.extension,
          ...(body.phoneNumber !== undefined && { phoneNumber: body.phoneNumber }),
          isDefault: makeDefault,
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      });
    });

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.line_created",
      targetType: "TenantLine", targetId: line.id,
      after: { tenantId: request.params.id, name: line.name, extension: line.extension } as object, ip: request.ip,
    });

    return reply.status(201).send(line);
  });

  // PATCH /admin/tenants/:id/lines/:lineId
  fastify.patch<{ Params: { id: string; lineId: string } }>("/:id/lines/:lineId", { preHandler }, async (request, reply) => {
    const body = lineUpdateSchema.parse(request.body);
    const admin = request.adminUser!;

    const existing = await prisma.tenantLine.findFirst({ where: { id: request.params.lineId, tenantId: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Linha não encontrada" });

    const line = await prisma.$transaction(async (tx) => {
      if (body.isDefault === true) {
        await tx.tenantLine.updateMany({ where: { tenantId: request.params.id, id: { not: request.params.lineId } }, data: { isDefault: false } });
      }
      return tx.tenantLine.update({
        where: { id: request.params.lineId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.extension !== undefined && { extension: body.extension }),
          ...(body.phoneNumber !== undefined && { phoneNumber: body.phoneNumber }),
          ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      });
    });

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.line_updated",
      targetType: "TenantLine", targetId: line.id,
      before: existing as unknown as object, after: body as object, ip: request.ip,
    });

    return line;
  });

  // DELETE /admin/tenants/:id/lines/:lineId
  fastify.delete<{ Params: { id: string; lineId: string } }>("/:id/lines/:lineId", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const existing = await prisma.tenantLine.findFirst({ where: { id: request.params.lineId, tenantId: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Linha não encontrada" });

    await prisma.$transaction(async (tx) => {
      await tx.tenantLine.delete({ where: { id: request.params.lineId } });
      // Se apagámos a default, promover a linha mais antiga que sobra
      if (existing.isDefault) {
        const next = await tx.tenantLine.findFirst({ where: { tenantId: request.params.id }, orderBy: { createdAt: "asc" } });
        if (next) await tx.tenantLine.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.line_deleted",
      targetType: "TenantLine", targetId: request.params.lineId,
      before: existing as unknown as object, ip: request.ip,
    });

    return { ok: true };
  });

  // ============ LOGO ============

  // PUT /admin/tenants/:id/logo — logo do cliente no CRM (null = volta ao da Comunica)
  fastify.put<{ Params: { id: string } }>("/:id/logo", { preHandler }, async (request, reply) => {
    const parsed = logoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Logo inválido" });
    const { logoDataUrl } = parsed.data;
    const admin = request.adminUser!;
    const existing = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
    if (!existing) return reply.status(404).send({ error: "Tenant não encontrado" });
    await prisma.tenant.update({ where: { id: request.params.id }, data: { logoDataUrl } });
    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: logoDataUrl ? "tenant.logo_updated" : "tenant.logo_removed",
      targetType: "Tenant", targetId: request.params.id, ip: request.ip,
    });
    return { logoDataUrl };
  });

  // ============ FUNCIONALIDADES ============

  // GET /admin/tenants/features — matriz clientes × funcionalidades (página global)
  fastify.get("/features", { preHandler }, async () => {
    const tenants = await prisma.tenant.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, status: true, features: true,
        plan: { select: { name: true, productType: true, aiAgentsEnabled: true, smsEnabled: true } },
      },
    });
    return {
      features: FEATURE_KEYS.map((key) => ({ key, label: FEATURE_LABELS[key], hint: FEATURE_HINTS[key], default: DEFAULT_FEATURES[key] })),
      tenants: tenants.map((t) => {
        const effective = computeFeatures({
          overrides: t.features,
          aiAgentsEnabled: t.plan?.aiAgentsEnabled,
          smsEnabled: t.plan?.smsEnabled,
          productType: t.plan?.productType,
        });
        // O que está desligado pelo plano e nenhum override liga.
        const locked = computeFeatures({
          overrides: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])),
          aiAgentsEnabled: t.plan?.aiAgentsEnabled,
          smsEnabled: t.plan?.smsEnabled,
          productType: t.plan?.productType,
        });
        return {
          id: t.id,
          name: t.name,
          status: t.status,
          plan: t.plan ? { name: t.plan.name, productType: t.plan.productType } : null,
          features: effective,
          overrides: (t.features ?? {}) as Record<string, boolean>,
          lockedByPlan: FEATURE_KEYS.filter((k) => !locked[k]),
        };
      }),
    };
  });

  // PATCH /admin/tenants/:id/features — muda só as chaves enviadas (célula da matriz)
  fastify.patch<{ Params: { id: string } }>("/:id/features", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const existing = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { features: true } });
    if (!existing) return reply.status(404).send({ error: "Tenant não encontrado" });
    const before = sanitizeFeatureOverrides(existing.features);
    const overrides = { ...before, ...sanitizeFeatureOverrides(featuresSchema.parse(request.body)) };
    await prisma.tenant.update({ where: { id: request.params.id }, data: { features: overrides } });
    invalidateTenantFeatures(request.params.id);
    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.features_updated",
      targetType: "Tenant", targetId: request.params.id,
      before: before as object, after: overrides as object, ip: request.ip,
    });
    return { overrides };
  });

  // PUT /admin/tenants/:id/features — grava overrides de funcionalidades
  fastify.put<{ Params: { id: string } }>("/:id/features", { preHandler }, async (request, reply) => {
    const body = featuresSchema.parse(request.body);
    const admin = request.adminUser!;

    const existing = await prisma.tenant.findFirst({
      where: { id: request.params.id, deletedAt: null },
      include: { plan: { select: { aiAgentsEnabled: true, smsEnabled: true, productType: true } } },
    });
    if (!existing) return reply.status(404).send({ error: "Tenant não encontrado" });

    const overrides = sanitizeFeatureOverrides(body);
    await prisma.tenant.update({ where: { id: request.params.id }, data: { features: overrides } });
    invalidateTenantFeatures(request.params.id);

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.features_updated",
      targetType: "Tenant", targetId: request.params.id,
      before: (existing.features ?? {}) as object, after: overrides as object, ip: request.ip,
    });

    return {
      featureOverrides: overrides,
      features: computeFeatures({
        overrides,
        aiAgentsEnabled: existing.plan?.aiAgentsEnabled,
        smsEnabled: existing.plan?.smsEnabled,
        productType: existing.plan?.productType,
      }),
    };
  });

  // ============ UTILIZADORES DO TENANT ============

  // GET /admin/tenants/:id/users — lista os utilizadores do cliente
  fastify.get<{ Params: { id: string } }>("/:id/users", { preHandler }, async (request, reply) => {
    const tenant = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    const users = await prisma.tenantUser.findMany({
      where: { tenantId: request.params.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true, role: true, lastLoginAt: true, twoFaSecret: true, createdAt: true },
    });

    // Nunca expomos a passwordHash. Indicamos apenas se o 2FA está activo.
    return {
      users: users.map((u) => ({
        id: u.id, name: u.name, email: u.email, role: u.role,
        lastLoginAt: u.lastLoginAt, twoFaEnabled: !!u.twoFaSecret, createdAt: u.createdAt,
      })),
    };
  });

  // POST /admin/tenants/:id/users/:userId/reset-password — define nova password
  fastify.post<{ Params: { id: string; userId: string }; Body: { password: string } }>(
    "/:id/users/:userId/reset-password",
    { preHandler },
    async (request, reply) => {
      const admin = request.adminUser!;
      const password = resetPasswordSchema.parse(request.body).password;

      const user = await prisma.tenantUser.findFirst({
        where: { id: request.params.userId, tenantId: request.params.id },
        select: { id: true, email: true },
      });
      if (!user) return reply.status(404).send({ error: "Utilizador não encontrado" });

      await prisma.tenantUser.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });

      await fastify.audit({
        actorType: "ADMIN", actorId: admin.sub, action: "tenant.user.password_reset",
        targetType: "TenantUser", targetId: user.id,
        after: { tenantId: request.params.id, email: user.email } as object, ip: request.ip,
      });

      return { ok: true };
    },
  );

  // POST /admin/tenants/:id/users — cria um novo utilizador para o cliente
  fastify.post<{ Params: { id: string } }>("/:id/users", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const body = userCreateSchema.parse(request.body);

    const tenant = await prisma.tenant.findFirst({ where: { id: request.params.id, deletedAt: null }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    const existingEmail = await prisma.tenantUser.findUnique({ where: { email: body.email } });
    if (existingEmail) return reply.status(409).send({ error: "Email já registado" });

    const user = await prisma.tenantUser.create({
      data: {
        tenantId: request.params.id,
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: body.role ?? "MEMBER",
      },
      select: { id: true, name: true, email: true, role: true, lastLoginAt: true, createdAt: true },
    });

    await fastify.audit({
      actorType: "ADMIN", actorId: admin.sub, action: "tenant.user.created",
      targetType: "TenantUser", targetId: user.id,
      after: { tenantId: request.params.id, email: user.email, role: user.role } as object, ip: request.ip,
    });

    return reply.status(201).send({ ...user, twoFaEnabled: false });
  });
};
