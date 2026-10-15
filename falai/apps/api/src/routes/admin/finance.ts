import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { upsertSetting } from "../../services/settings.service.js";
import { PROVIDER_COST_PER_CALL_SETTING, getProviderCostPerCallCents } from "../../services/billing.service.js";

const topUpSchema = z.object({
  amountCents: z.number().int().positive(),
  note: z.string().trim().max(280).optional(),
});

const providerCostSchema = z.object({
  costPerCallCents: z.number().int().min(0),
});

export const adminFinanceRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/finance/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
  fastify.get<{ Querystring: { from: string; to: string } }>(
    "/finance/summary", { preHandler }, async (request) => {
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      to.setHours(23, 59, 59, 999);

      const [calls, paidInvoices] = await Promise.all([
        prisma.call.findMany({
          where: { createdAt: { gte: from, lte: to }, status: "COMPLETED" },
          select: { costCents: true, providerCostCents: true, durationSecs: true, createdAt: true },
        }),
        // Receita de subscrições (mensalidades pagas no período)
        prisma.invoice.findMany({
          where: { status: "PAID", paidAt: { gte: from, lte: to } },
          select: { amountCents: true, paidAt: true },
        }),
      ]);

      const callRevenueCents = calls.reduce((s, c) => s + c.costCents, 0);
      const subscriptionRevenueCents = paidInvoices.reduce((s, i) => s + i.amountCents, 0);
      const revenueCents = callRevenueCents + subscriptionRevenueCents;
      const providerCostCents = calls.reduce((s, c) => s + c.providerCostCents, 0);
      // Subscrições não têm custo de provider → margem total
      const marginCents = revenueCents - providerCostCents;
      const marginPct = revenueCents > 0 ? Math.round((marginCents / revenueCents) * 100) : 0;
      const totalMinutes = Math.round(calls.reduce((s, c) => s + c.durationSecs, 0) / 60);

      // Daily buckets
      const buckets: Record<string, { revenueCents: number; costCents: number; marginCents: number; calls: number }> = {};
      const cursor = new Date(from);
      while (cursor <= to) {
        const key = cursor.toISOString().slice(0, 10);
        buckets[key] = { revenueCents: 0, costCents: 0, marginCents: 0, calls: 0 };
        cursor.setDate(cursor.getDate() + 1);
      }
      for (const c of calls) {
        const key = c.createdAt.toISOString().slice(0, 10);
        if (buckets[key]) {
          buckets[key]!.revenueCents += c.costCents;
          buckets[key]!.costCents += c.providerCostCents;
          buckets[key]!.marginCents += c.costCents - c.providerCostCents;
          buckets[key]!.calls++;
        }
      }
      for (const inv of paidInvoices) {
        const key = (inv.paidAt ?? from).toISOString().slice(0, 10);
        if (buckets[key]) {
          buckets[key]!.revenueCents += inv.amountCents;
          buckets[key]!.marginCents += inv.amountCents;
        }
      }
      const chartData = Object.entries(buckets).map(([date, v]) => ({ date, ...v }));

      return {
        revenueCents,
        subscriptionRevenueCents,
        callRevenueCents,
        providerCostCents,
        marginCents,
        marginPct,
        totalCalls: calls.length,
        totalMinutes,
        chartData,
      };
    }
  );

  // GET /admin/finance/transactions
  fastify.get<{ Querystring: { page?: string; type?: string; tenantId?: string } }>(
    "/finance/transactions", { preHandler }, async (request) => {
      const page = parseInt(request.query.page ?? "1", 10);
      const perPage = 25;
      const skip = (page - 1) * perPage;

      const where = {
        ...(request.query.type && { type: request.query.type as any }),
        ...(request.query.tenantId && { tenantId: request.query.tenantId }),
      };

      const [txs, total] = await Promise.all([
        prisma.walletTransaction.findMany({
          where, orderBy: { createdAt: "desc" }, take: perPage, skip,
          include: { tenant: { select: { name: true } } },
        }),
        prisma.walletTransaction.count({ where }),
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

  // GET /admin/finance/margin-report?from=&to=
  fastify.get<{ Querystring: { from: string; to: string } }>(
    "/finance/margin-report", { preHandler }, async (request) => {
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      to.setHours(23, 59, 59, 999);

      const [calls, paidInvoices] = await Promise.all([
        prisma.call.findMany({
          where: { createdAt: { gte: from, lte: to }, status: "COMPLETED" },
          select: { tenantId: true, costCents: true, providerCostCents: true, tenant: { select: { name: true } } },
        }),
        prisma.invoice.findMany({
          where: { status: "PAID", paidAt: { gte: from, lte: to } },
          select: { tenantId: true, amountCents: true, tenant: { select: { name: true } } },
        }),
      ]);

      const byTenant: Record<string, { name: string; rev: number; cost: number; calls: number }> = {};
      for (const c of calls) {
        if (!byTenant[c.tenantId]) {
          byTenant[c.tenantId] = { name: c.tenant.name, rev: 0, cost: 0, calls: 0 };
        }
        byTenant[c.tenantId]!.rev += c.costCents;
        byTenant[c.tenantId]!.cost += c.providerCostCents;
        byTenant[c.tenantId]!.calls++;
      }
      // Receita de subscrições por tenant (sem custo de provider)
      for (const inv of paidInvoices) {
        if (!byTenant[inv.tenantId]) {
          byTenant[inv.tenantId] = { name: inv.tenant.name, rev: 0, cost: 0, calls: 0 };
        }
        byTenant[inv.tenantId]!.rev += inv.amountCents;
      }

      return Object.entries(byTenant).map(([tenantId, v]) => ({
        tenantId, tenantName: v.name,
        revenueCents: v.rev, costCents: v.cost,
        marginCents: v.rev - v.cost,
        marginPct: v.rev > 0 ? Math.round(((v.rev - v.cost) / v.rev) * 100) : 0,
        calls: v.calls,
      }));
    }
  );

  // GET /admin/finance/provider-balance
  // Saldo comprado ao fornecedor (voz/telefonia) menos o custo já consumido
  // (Call.providerCostCents), para controlar quanto ainda resta.
  fastify.get("/finance/provider-balance", { preHandler }, async () => {
    const [costPerCallCents, purchased, spent, topups] = await Promise.all([
      getProviderCostPerCallCents(),
      prisma.providerTopUp.aggregate({ _sum: { amountCents: true } }),
      prisma.call.aggregate({ _sum: { providerCostCents: true } }),
      prisma.providerTopUp.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    ]);

    const purchasedCents = purchased._sum.amountCents ?? 0;
    const spentCents = spent._sum.providerCostCents ?? 0;

    return {
      costPerCallCents,
      purchasedCents,
      spentCents,
      remainingCents: purchasedCents - spentCents,
      topups,
    };
  });

  // PUT /admin/finance/provider-cost — actualiza o custo fixo por chamada
  fastify.put("/finance/provider-cost", { preHandler }, async (request, reply) => {
    const body = providerCostSchema.parse(request.body);
    const admin = request.adminUser!;

    await upsertSetting({
      key: PROVIDER_COST_PER_CALL_SETTING,
      value: String(body.costPerCallCents),
      updatedBy: admin.sub,
    });

    return reply.status(200).send({ ok: true, costPerCallCents: body.costPerCallCents });
  });

  // POST /admin/finance/provider-topup — regista uma compra de saldo ao fornecedor
  fastify.post("/finance/provider-topup", { preHandler }, async (request, reply) => {
    const body = topUpSchema.parse(request.body);
    const admin = request.adminUser!;

    const topup = await prisma.providerTopUp.create({
      data: { amountCents: body.amountCents, note: body.note ?? null, createdBy: admin.sub },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "provider_topup.create",
      targetType: "ProviderTopUp",
      targetId: topup.id,
      after: { amountCents: body.amountCents, note: body.note ?? null },
      ip: request.ip,
    });

    return reply.status(201).send(topup);
  });
};
