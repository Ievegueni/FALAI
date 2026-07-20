import { prisma, type BillingMode } from "@falai/db";

export interface PriceConfig {
  billingMode: BillingMode;
  pricePerMinuteCents: number;
  pricePerCallCents: number;
}

/**
 * Custo real de uma chamada conforme o modo de cobrança.
 *   PER_MINUTE → ceil(segundos/60) × preço/min (arredonda ao minuto)
 *   PER_SECOND → round(segundos × preço/min / 60) (ao segundo exacto)
 *   PER_CALL   → preço fixo por chamada (0 se a chamada não teve duração)
 */
export function computeCallCost(billedSecs: number, price: PriceConfig): number {
  switch (price.billingMode) {
    case "PER_SECOND":
      return Math.round((billedSecs * price.pricePerMinuteCents) / 60);
    case "PER_CALL":
      return billedSecs > 0 ? price.pricePerCallCents : 0;
    case "PER_MINUTE":
    default:
      return Math.ceil(billedSecs / 60) * price.pricePerMinuteCents;
  }
}

/**
 * Valor a reservar no arranque — o custo MÁXIMO possível da chamada,
 * assumindo que dura `maxCallSeconds`. Para PER_CALL é o preço fixo.
 */
export function computeReservation(maxCallSeconds: number, price: PriceConfig): number {
  switch (price.billingMode) {
    case "PER_SECOND":
      return Math.ceil((maxCallSeconds * price.pricePerMinuteCents) / 60);
    case "PER_CALL":
      return price.pricePerCallCents;
    case "PER_MINUTE":
    default:
      return Math.ceil(maxCallSeconds / 60) * price.pricePerMinuteCents;
  }
}

/** Modo de cobrança efectivo: override do tenant tem prioridade sobre o do plano. */
export function effectiveBillingMode(
  planMode: BillingMode,
  tenantOverride: BillingMode | null | undefined,
): BillingMode {
  return tenantOverride ?? planMode;
}

/**
 * Atomically reserve `estimatedCents` from a tenant's wallet.
 * Returns false if the tenant has insufficient balance (considering credit limit).
 */
export async function reserveBalance(tenantId: string, estimatedCents: number): Promise<boolean> {
  if (estimatedCents <= 0) return true;

  const count = await prisma.$executeRaw`
    UPDATE "Tenant"
    SET "balanceCents" = "balanceCents" - ${estimatedCents}
    WHERE id = ${tenantId}
      AND "balanceCents" + "creditLimitCents" >= ${estimatedCents}
  `;

  return count > 0;
}

/**
 * Settle a completed call: create a CALL_CHARGE transaction for the actual cost,
 * refund any over-reserved amount, and update Call.costCents + billedSecs.
 *
 * The `reservedCents` must have been subtracted from the balance at call start.
 * This function adjusts the balance for the difference.
 */
export async function settleCall(params: {
  callId: string;
  tenantId: string;
  billedSecs: number;
  reservedCents: number;
  price: PriceConfig;
}): Promise<void> {
  const { callId, tenantId, billedSecs, reservedCents, price } = params;
  if (reservedCents <= 0) return; // non-billable call (admin test, etc.)

  const actualCents = computeCallCost(billedSecs, price);
  // Positive = over-reserved (refund to tenant); negative = under-reserved (extra debit)
  const delta = reservedCents - actualCents;

  await prisma.$transaction(async (tx) => {
    await tx.call.update({
      where: { id: callId },
      data: { costCents: actualCents, billedSecs },
    });

    if (delta !== 0) {
      await tx.tenant.update({
        where: { id: tenantId },
        data: { balanceCents: { increment: delta } },
      });
    }

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { balanceCents: true },
    });

    await tx.walletTransaction.create({
      data: {
        tenantId,
        type: "CALL_CHARGE",
        amountCents: -actualCents,
        balanceAfterCents: tenant.balanceCents,
        note: `Chamada ${callId} — ${billedSecs}s`,
        reference: callId,
      },
    });
  });
}

/**
 * Cobrança flat de uma chamada de entrega única (OTP): debita `pricePerCallCents`
 * de forma atómica e regista o movimento CALL_CHARGE. Não há reserva/acerto porque
 * a chamada é fire-and-forget (sem evento de fim).
 *
 * Devolve false se o saldo (com limite de crédito) não chega.
 */
export async function chargeFlatCall(params: {
  callId: string;
  tenantId: string;
  amountCents: number;
  note?: string;
}): Promise<boolean> {
  const { callId, tenantId, amountCents, note } = params;
  if (amountCents <= 0) return true; // grátis

  const debited = await reserveBalance(tenantId, amountCents);
  if (!debited) return false;

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { balanceCents: true },
  });

  await Promise.all([
    prisma.walletTransaction.create({
      data: {
        tenantId,
        type: "CALL_CHARGE",
        amountCents: -amountCents,
        balanceAfterCents: tenant.balanceCents,
        note: note ?? `Chamada ${callId}`,
        reference: callId,
      },
    }),
    prisma.call.update({ where: { id: callId }, data: { costCents: amountCents } }).catch(() => undefined),
  ]);

  return true;
}
