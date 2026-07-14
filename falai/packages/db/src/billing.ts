import { prisma } from "./index.js";

/**
 * Faturação da subscrição mensal (mensalidade do plano).
 *
 * Cria uma fatura idempotente por período (YYYY-MM), tenta pagar da carteira
 * (respeitando o limite de crédito) e, se não houver saldo, marca a fatura como
 * DUE. Tenants CRM com fatura DUE de um período anterior são suspensos.
 */

export function currentPeriod(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7); // "YYYY-MM"
}

function nextBillingDate(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 2, 0, 0));
}

export type BillingResult =
  | { status: "SKIPPED"; reason: string }
  | { status: "ALREADY_PAID"; invoiceId: string; amountCents: number }
  | { status: "PAID"; invoiceId: string; amountCents: number; balanceAfterCents: number }
  | { status: "DUE"; invoiceId: string; amountCents: number; suspended: boolean };

/** Cobra (ou tenta cobrar) a mensalidade de um tenant para um período. */
export async function chargeMonthlyInvoice(tenantId: string, opts?: { period?: string }): Promise<BillingResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      status: true,
      balanceCents: true,
      creditLimitCents: true,
      plan: { select: { monthlyFeeCents: true, productType: true } },
    },
  });
  if (!tenant) return { status: "SKIPPED", reason: "tenant not found" };

  const fee = tenant.plan.monthlyFeeCents;
  if (fee <= 0) return { status: "SKIPPED", reason: "no monthly fee" };
  if (tenant.status === "CLOSED") return { status: "SKIPPED", reason: "tenant closed" };

  const period = opts?.period ?? currentPeriod();

  const existing = await prisma.invoice.findUnique({ where: { tenantId_period: { tenantId, period } } });
  if (existing && existing.status === "PAID") {
    return { status: "ALREADY_PAID", invoiceId: existing.id, amountCents: existing.amountCents };
  }

  const canPay = tenant.balanceCents - fee >= -tenant.creditLimitCents;

  if (canPay) {
    const balanceAfterCents = tenant.balanceCents - fee;
    const [, , invoice] = await prisma.$transaction([
      prisma.tenant.update({
        where: { id: tenantId },
        data: { balanceCents: { decrement: fee }, nextBillingAt: nextBillingDate() },
      }),
      prisma.walletTransaction.create({
        data: {
          tenantId,
          type: "MONTHLY_FEE",
          amountCents: -fee,
          balanceAfterCents,
          note: `Mensalidade ${period}`,
        },
      }),
      prisma.invoice.upsert({
        where: { tenantId_period: { tenantId, period } },
        create: { tenantId, period, amountCents: fee, status: "PAID", paidAt: new Date() },
        update: { status: "PAID", paidAt: new Date(), amountCents: fee },
      }),
    ]);
    return { status: "PAID", invoiceId: invoice.id, amountCents: fee, balanceAfterCents };
  }

  // Sem saldo → fatura em dívida
  const invoice = await prisma.invoice.upsert({
    where: { tenantId_period: { tenantId, period } },
    create: { tenantId, period, amountCents: fee, status: "DUE" },
    update: { amountCents: fee },
  });

  // Suspensão: fatura DUE de período anterior por pagar (só produto CRM) → suspende o acesso
  let suspended = false;
  if (tenant.plan.productType === "CRM_BYO_PBX" && tenant.status === "ACTIVE") {
    const overdue = await prisma.invoice.count({
      where: { tenantId, status: "DUE", period: { lt: period } },
    });
    if (overdue > 0) {
      await prisma.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED" } });
      suspended = true;
    }
  }

  return { status: "DUE", invoiceId: invoice.id, amountCents: fee, suspended };
}

/** Corre a faturação mensal para todos os tenants elegíveis (usado pelo job agendado). */
export async function runMonthlyBilling(): Promise<{ paid: number; due: number; skipped: number }> {
  const tenants = await prisma.tenant.findMany({
    where: { status: { in: ["TRIAL", "ACTIVE"] }, deletedAt: null, plan: { monthlyFeeCents: { gt: 0 } } },
    select: { id: true },
  });
  let paid = 0;
  let due = 0;
  let skipped = 0;
  for (const t of tenants) {
    const r = await chargeMonthlyInvoice(t.id);
    if (r.status === "PAID") paid++;
    else if (r.status === "DUE") due++;
    else skipped++;
  }
  return { paid, due, skipped };
}
