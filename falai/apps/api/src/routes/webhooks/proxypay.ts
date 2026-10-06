import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@falai/db";
import { resolveProviderConfig } from "../../services/providerConfig.service.js";

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

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Este endpoint credita saldo, por isso só aceita pedidos que provem vir da
 * ProxyPay. Antes, sem chave configurada (ou sem header de autenticação) não
 * se verificava nada: um POST de qualquer origem creditava o valor que
 * quisesse ao tenant que indicasse.
 *
 * Aceita a assinatura X-Signature (HMAC-SHA256 do corpo com a chave de API) ou
 * Basic auth com a chave. Sem chave configurada recusa sempre.
 */
export function isAuthenticProxyPayRequest(
  apiKey: string,
  rawBody: string | Buffer | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!apiKey) return false;

  const signature = headers["x-signature"];
  if (typeof signature === "string" && rawBody !== undefined) {
    const expected = createHmac("sha256", apiKey).update(rawBody).digest("hex");
    if (safeEqual(signature.toLowerCase(), expected)) return true;
  }

  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Basic ")) {
    const [key] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
    if (key && safeEqual(key, apiKey)) return true;
  }

  return false;
}

export const proxypayWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /webhooks/proxypay — called by ProxyPay when a payment is confirmed
  fastify.post<{ Body: ProxyPayPayment }>("/", { config: { rawBody: true } }, async (request, reply) => {
    const { proxypay } = await resolveProviderConfig();
    if (!isAuthenticProxyPayRequest(proxypay.apiKey, request.rawBody, request.headers)) {
      fastify.log.warn({ ip: request.ip, configured: !!proxypay.apiKey }, "proxypay.unauthorized");
      return reply.status(401).send({ error: "Unauthorized" });
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
