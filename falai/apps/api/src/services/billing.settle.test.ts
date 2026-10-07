import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * settleCall reclama a reserva persistida em Call.reservedCents. Se outro
 * caminho (reconciliação, arranque da API) já a devolveu, o acerto não pode
 * mexer outra vez no saldo — seria reembolso duplo.
 */

let claimCount = 1;
const tx = {
  call: { updateMany: vi.fn(async () => ({ count: claimCount })) },
  tenant: { update: vi.fn(async () => ({})), findUniqueOrThrow: vi.fn(async () => ({ balanceCents: 1000 })) },
  walletTransaction: { create: vi.fn(async () => ({})) },
};
const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };

vi.mock("@falai/db", () => ({ prisma }));
vi.mock("./settings.service.js", () => ({ getSetting: vi.fn(async () => "0") }));

const { settleCall } = await import("./billing.service.js");

const price = { billingMode: "PER_MINUTE" as const, pricePerMinuteCents: 100, pricePerCallCents: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  claimCount = 1;
});

describe("settleCall", () => {
  it("reclama a reserva e devolve o excedente uma vez", async () => {
    await settleCall({ callId: "c1", tenantId: "t1", billedSecs: 60, reservedCents: 500, price });
    expect(tx.call.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", reservedCents: 500 },
      data: expect.objectContaining({ reservedCents: 0, costCents: 100, billedSecs: 60 }),
    });
    expect(tx.tenant.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { balanceCents: { increment: 400 } } });
    expect(tx.walletTransaction.create).toHaveBeenCalledOnce();
  });

  it("reserva já devolvida por outro caminho: não mexe no saldo nem cobra", async () => {
    claimCount = 0;
    await settleCall({ callId: "c1", tenantId: "t1", billedSecs: 60, reservedCents: 500, price });
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });
});
