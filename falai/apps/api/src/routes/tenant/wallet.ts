import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";

const topupSchema = z.object({
  amountCents: z.number().int().min(100_00).max(50_000_00), // 100 Kz to 500,000 Kz
});

const PROXYPAY_ENTITY = process.env["PROXYPAY_ENTITY"] ?? "99999"; // Multicaixa entity code

export const tenantWalletRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/wallet — balance + recent transactions
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;

    const [tenant, recentTx] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          balanceCents: true,
          creditLimitCents: true,
          plan: { select: { name: true, pricePerMinuteCents: true, pricePerCallCents: true, monthlyFeeCents: true } },
        },
      }),
      prisma.walletTransaction.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    return { balance: tenant, recentTransactions: recentTx };
  });

  // GET /tenant/wallet/transactions — paginated history
  fastify.get<{
    Querystring: { type?: string; limit?: string; offset?: string };
  }>("/transactions", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const { type, limit = "50", offset = "0" } = request.query;

    const transactions = await prisma.walletTransaction.findMany({
      where: {
        tenantId,
        ...(type && { type: type as import("@falai/db").TxType }),
      },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit, 10),
      skip: parseInt(offset, 10),
    });

    const total = await prisma.walletTransaction.count({ where: { tenantId } });
    return { transactions, total };
  });

  // POST /tenant/wallet/topup — create ProxyPay Multicaixa reference
  fastify.post("/topup", { preHandler }, async (request, reply) => {
    const body = topupSchema.parse(request.body);
    const { tenantId, sub: userId } = request.tenantUser!;

    const proxypayApiKey = process.env["PROXYPAY_API_KEY"];
    const stubMode = !proxypayApiKey || process.env["PROXYPAY_STUB_MODE"] === "true";

    let reference: string;
    let expiresAt: Date;

    if (stubMode) {
      // Stub: generate a fake reference for testing
      reference = String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
      expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days
    } else {
      // Real ProxyPay API call
      const paymentId = `topup_${tenantId}_${Date.now()}`;
      const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

      const res = await fetch("https://api.proxypay.co.ao/references", {
        method: "POST",
        headers: {
          Authorization: `Token ${proxypayApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: (body.amountCents / 100).toFixed(2),
          end_datetime: expiryDate.toISOString(),
          custom_data: { tenantId, userId, paymentId },
        }),
      });

      if (!res.ok) {
        fastify.log.error({ status: res.status, body: await res.text() }, "proxypay.create_reference_failed");
        return reply.status(502).send({ error: "Falha ao gerar referência de pagamento. Tenta novamente." });
      }

      const data = await res.json() as { reference: string; id: string };
      reference = data.reference;
      expiresAt = expiryDate;

      // Store ProxyPay reference ID for webhook matching
      await fastify.redis.set(
        `proxypay:ref:${data.id}`,
        JSON.stringify({ tenantId, amountCents: body.amountCents, userId }),
        "EX", 4 * 24 * 60 * 60
      );
    }

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: userId,
      action: "wallet.topup_requested",
      targetType: "Tenant",
      targetId: tenantId,
      after: { amountCents: body.amountCents, reference } as object,
      ip: request.ip,
    });

    return {
      entity: PROXYPAY_ENTITY,
      reference,
      amountCents: body.amountCents,
      expiresAt,
      instructions: `Pague ${(body.amountCents / 100).toFixed(2)} Kz na Entidade ${PROXYPAY_ENTITY}, Referência ${reference} via ATM ou Internet Banking.`,
      isStub: stubMode,
    };
  });
};
