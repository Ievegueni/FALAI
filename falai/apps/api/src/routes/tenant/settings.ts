import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { createHmac, randomBytes } from "crypto";

export async function tenantSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/settings — current webhook config + plan info
  fastify.get("/tenant/settings", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        nif: true,
        status: true,
        maxConcurrent: true,
        webhookUrl: true,
        // Never return webhookSecret raw — only whether one is set
        plan: { select: { name: true, pricePerMinuteCents: true, maxAgents: true, maxConcurrent: true } },
        createdAt: true,
      },
    });

    if (!tenant) return reply.status(404).send({ error: "Tenant not found" });

    const hasWebhookSecret = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { webhookSecret: true },
    });

    return reply.send({
      ...tenant,
      webhookSecretConfigured: !!hasWebhookSecret?.webhookSecret,
    });
  });

  // PATCH /tenant/settings — update webhookUrl, rotate secret
  fastify.patch("/tenant/settings", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = request.body as {
      webhookUrl?: string | null;
      rotateWebhookSecret?: boolean;
      name?: string;
    };

    let newSecret: string | undefined;

    const update: Record<string, unknown> = {};
    if (body.webhookUrl !== undefined) update["webhookUrl"] = body.webhookUrl;
    if (body.name !== undefined && body.name.trim().length > 0) update["name"] = body.name.trim();
    if (body.rotateWebhookSecret === true) {
      newSecret = `whsec_${randomBytes(24).toString("hex")}`;
      // Store HMAC of the secret so it's not reversible, but we return the raw once
      update["webhookSecret"] = newSecret;
    }

    await prisma.tenant.update({ where: { id: tenantId }, data: update });

    return reply.send({
      ok: true,
      ...(newSecret !== undefined && {
        webhookSecret: newSecret,
        warning: "Save this secret — it will not be shown again. Use it to verify X-Falai-Signature headers.",
      }),
    });
  });

  // POST /tenant/settings/webhook-test — sends a test event to the configured URL
  fastify.post("/tenant/settings/webhook-test", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { webhookUrl: true, webhookSecret: true },
    });

    if (!tenant?.webhookUrl) {
      return reply.status(422).send({ error: "No webhook URL configured. Set it via PATCH /tenant/settings first." });
    }

    const body = JSON.stringify({
      event: "webhook.test",
      timestamp: new Date().toISOString(),
      data: { message: "Webhook test from Falaí — if you see this, delivery works." },
    });

    const signature = tenant.webhookSecret
      ? `sha256=${createHmac("sha256", tenant.webhookSecret).update(body).digest("hex")}`
      : undefined;

    try {
      const res = await fetch(tenant.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Falai-Webhook/1.0",
          ...(signature && { "X-Falai-Signature": signature }),
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      return reply.send({ ok: res.ok, statusCode: res.status });
    } catch (err) {
      return reply.status(502).send({ error: "Webhook delivery failed", detail: String(err) });
    }
  });
}
