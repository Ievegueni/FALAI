import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";

export const tenantBillingRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/billing — resumo da subscrição + histórico de faturas
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;

    const [tenant, invoices, dueCount] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          status: true,
          balanceCents: true,
          nextBillingAt: true,
          plan: { select: { name: true, productType: true, monthlyFeeCents: true } },
        },
      }),
      prisma.invoice.findMany({
        where: { tenantId },
        orderBy: { period: "desc" },
        take: 24,
        select: { id: true, period: true, amountCents: true, status: true, issuedAt: true, paidAt: true },
      }),
      prisma.invoice.count({ where: { tenantId, status: "DUE" } }),
    ]);

    return {
      subscription: {
        planName: tenant.plan.name,
        productType: tenant.plan.productType,
        monthlyFeeCents: tenant.plan.monthlyFeeCents,
        nextBillingAt: tenant.nextBillingAt,
        balanceCents: tenant.balanceCents,
        status: dueCount > 0 ? "PAST_DUE" : tenant.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
        dueCount,
      },
      invoices,
    };
  });
};
