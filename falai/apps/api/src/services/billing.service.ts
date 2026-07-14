import { prisma } from "@falai/db";

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
  pricePerMinuteCents: number;
  reservedCents: number;
}): Promise<void> {
  const { callId, tenantId, billedSecs, pricePerMinuteCents, reservedCents } = params;
  if (reservedCents <= 0) return; // non-billable call (admin test, etc.)

  const actualCents = Math.ceil(billedSecs / 60) * pricePerMinuteCents;
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
