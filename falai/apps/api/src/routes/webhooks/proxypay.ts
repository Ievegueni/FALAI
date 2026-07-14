import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";

interface ProxyPayPayment {
  id: string;
  reference: string;
  entity: string;
  amount: string;
  terminal_type?: string;
  terminal_id?: string;
  payment_date?: string;
  period_start_datetime?: string;
  period_end_datetime?: string;
  custom_data?: { tenantId?: string; amountCents?: number; userId?: string };
}

export const proxypayWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /webhooks/proxypay — called by ProxyPay when a payment is confirmed
  fastify.post<{ Body: ProxyPayPayment }>("/", async (request, reply) => {
    const proxypayApiKey = process.env["PROXYPAY_API_KEY"] ?? "";

    // Verify Basic auth from ProxyPay (header: Authorization: Basic <base64(api_key:)>)
    const authHeader = request.headers["authorization"];
    const stubMode = !proxypayApiKey || process.env["PROXYPAY_STUB_MODE"] === "true";

    if (!stubMode && authHeader) {
      const [, encoded] = authHeader.split(" ");
      const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
      const [key] = decoded.split(":");
      if (key !== proxypayApiKey) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }

    const payment = request.body;
    if (!payment?.id) return reply.status(400).send({ error: "Invalid payload" });

    fastify.log.info({ paymentId: payment.id, reference: payment.reference }, "proxypay.payment_received");

    // Look up tenant from Redis (set at topup request time)
    const cached = await fastify.redis.get(`proxypay:ref:${payment.id}`);
    let tenantId: string | null = null;
    let amountCents: number;

    if (cached) {
      const meta = JSON.parse(cached) as { tenantId: string; amountCents: number };
      tenantId = meta.tenantId;
      amountCents = meta.amountCents;
    } else if (payment.custom_data?.tenantId) {
      tenantId = payment.custom_data.tenantId;
      amountCents = payment.custom_data.amountCents ?? Math.round(parseFloat(payment.amount) * 100);
    } else {
      fastify.log.warn({ paymentId: payment.id }, "proxypay.tenant_not_found");
      return reply.status(200).send({ received: true }); // ACK to avoid retries
    }

    // Idempotency: check if already processed
    const existing = await prisma.walletTransaction.findUnique({
      where: { proxypayRef: payment.id },
    });
    if (existing) {
      fastify.log.info({ paymentId: payment.id }, "proxypay.already_processed");
      return reply.status(200).send({ received: true });
    }

    // Credit the wallet atomically
    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: tenantId! },
        data: { balanceCents: { increment: amountCents } },
      });

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId! },
        select: { balanceCents: true },
      });

      await tx.walletTransaction.create({
        data: {
          tenantId: tenantId!,
          type: "TOPUP",
          amountCents,
          balanceAfterCents: tenant.balanceCents,
          proxypayRef: payment.id,
          reference: payment.reference,
          note: `Top-up via Multicaixa — ref ${payment.reference}`,
        },
      });
    });

    // Resume any campaigns that were paused due to low balance
    await prisma.campaign.updateMany({
      where: { tenantId: tenantId!, status: "PAUSED" },
      data: { status: "RUNNING" },
    });

    await fastify.redis.del(`proxypay:ref:${payment.id}`);

    fastify.log.info({ tenantId, amountCents, paymentId: payment.id }, "proxypay.wallet_credited");

    return reply.status(200).send({ received: true });
  });
};
