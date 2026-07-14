import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@falai/db";
import type { YeastarAdapter } from "@falai/providers";

const WEBHOOK_SECRET_KEY = "yeastar.webhook_secret";

export const yeastarWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: Record<string, unknown> }>(
    "/",
    { config: { rawBody: true } },
    async (request, reply) => {
      const signature = request.headers["x-signature"] as string | undefined;

      if (signature) {
        const secret = await getWebhookSecret();
        if (secret) {
          // fastify-raw-body provides rawBody as string | Buffer
          const rawBody = request.rawBody;
          const bodyBuf = rawBody === undefined
            ? Buffer.alloc(0)
            : Buffer.isBuffer(rawBody)
              ? rawBody
              : Buffer.from(rawBody, "utf8");

          const valid = validateHmac(bodyBuf, signature, secret);
          if (!valid) {
            fastify.log.warn({ ip: request.ip }, "yeastar.webhook.invalid_signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }
      }

      const payload = request.body;
      fastify.log.info({ payload }, "yeastar.webhook.received");

      await prisma.systemEvent.create({
        data: {
          severity: "INFO",
          source: "yeastar",
          message: `Webhook event: ${String(payload["event"] ?? "unknown")}`,
          payload: payload as object,
        },
      });

      const yeastar = fastify.yeastar as YeastarAdapter;
      yeastar.handleWebhookEvent(payload);

      return reply.status(200).send({ errcode: 0, errmsg: "OK" });
    }
  );
};

function validateHmac(body: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

async function getWebhookSecret(): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: WEBHOOK_SECRET_KEY } });
  if (!row) return null;
  if (row.isSecret) {
    const { decryptSecret } = await import("../../services/crypto.service.js");
    return decryptSecret(row.value);
  }
  return row.value;
}
