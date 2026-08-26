import { Worker, Queue } from "bullmq";
import { createHmac } from "crypto";
import pino from "pino";
import { prisma, type Prisma, runMonthlyBilling } from "@falai/db";
import { QUEUES, JOBS } from "@falai/shared";

const isDev = process.env["NODE_ENV"] === "development";
const log = isDev
  ? pino({ level: process.env["LOG_LEVEL"] ?? "info", transport: { target: "pino-pretty", options: { colorize: true } } })
  : pino({ level: process.env["LOG_LEVEL"] ?? "info" });

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

// BullMQ accepts URL string as connection
const connection = { url: REDIS_URL };

// ── Call Engine Worker (Sprint 1: estrutura base) ─────────────────────────
const callEngineWorker = new Worker(
  QUEUES.CALL_ENGINE,
  async (job) => {
    log.info({ jobId: job.id, name: job.name }, "call_engine.job.processing");
    switch (job.name) {
      case "dial":
        log.info({ callId: (job.data as Record<string, unknown>)["callId"] }, "call_engine.dial — Sprint 2: máquina de estados");
        break;
      default:
        log.warn({ jobName: job.name }, "call_engine.unknown_job");
    }
  },
  { connection, concurrency: 10 }
);

// ── Billing Worker ────────────────────────────────────────────────────────
const billingWorker = new Worker(
  QUEUES.BILLING,
  async (job) => {
    log.info({ jobId: job.id }, "billing.job.processing");
    // Sprint 4: débito de chamadas e ProxyPay
  },
  { connection, concurrency: 5 }
);

// ── Outbound Webhooks Worker ──────────────────────────────────────────────
interface WebhookJobData {
  /** Ausente em eventos que não são de chamada (ex.: campaign.completed). */
  callId: string | null;
  tenantId: string;
  event: string;
  payload: Record<string, unknown>;
}

const webhooksOutWorker = new Worker(
  QUEUES.WEBHOOKS_OUT,
  async (job) => {
    if (job.name !== JOBS.DELIVER_WEBHOOK) {
      log.warn({ jobName: job.name }, "webhooks_out.unknown_job");
      return;
    }

    const data = job.data as WebhookJobData;
    log.info({ jobId: job.id, tenantId: data.tenantId, event: data.event }, "webhooks_out.delivering");

    const tenant = await prisma.tenant.findUnique({
      where: { id: data.tenantId },
      select: { webhookUrl: true, webhookSecret: true },
    });

    if (!tenant?.webhookUrl) {
      log.info({ tenantId: data.tenantId }, "webhooks_out.no_url — skip");
      return;
    }

    const body = JSON.stringify({
      event: data.event,
      timestamp: new Date().toISOString(),
      data: data.payload,
    });

    const signature = tenant.webhookSecret
      ? `sha256=${createHmac("sha256", tenant.webhookSecret).update(body).digest("hex")}`
      : undefined;

    const res = await fetch(tenant.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Falai-Webhook/1.0",
        ...(signature && { "X-Falai-Signature": signature }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Webhook delivery failed: HTTP ${res.status}`);
    }

    log.info({ jobId: job.id, status: res.status }, "webhooks_out.delivered");
  },
  { connection, concurrency: 20 }
);

webhooksOutWorker.on("failed", async (job, err) => {
  log.error({ jobId: job?.id, err }, "webhooks_out.job.failed");

  // On permanent failure (exhausted retries), write to SystemEvent dead-letter
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    const data = job.data as WebhookJobData;
    await prisma.systemEvent.create({
      data: {
        severity: "ERROR",
        source: "webhooks_out",
        tenantId: data.tenantId,
        message: `Webhook delivery permanently failed after ${job.attemptsMade} attempts`,
        payload: { jobId: job.id, event: data.event, callId: data.callId, error: String(err) },
      },
    }).catch((e) => log.error({ e }, "webhooks_out.dead_letter_write_failed"));
  }
});

// ── Contact Import Worker ─────────────────────────────────────────────────
interface ImportJobData {
  jobId: string;
  tenantId: string;
  rows: Array<{ phone: string; name?: string; attributes?: Record<string, unknown> }>;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("244") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("00244") && digits.length === 14) return `+${digits.slice(2)}`;
  if (digits.length === 9) return `+244${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return null;
}

const contactImportWorker = new Worker(
  QUEUES.CONTACT_IMPORT,
  async (job) => {
    if (job.name !== JOBS.IMPORT_CONTACTS) return;
    const data = job.data as ImportJobData;
    const { jobId, tenantId, rows } = data;

    log.info({ jobId, tenantId, total: rows.length }, "contact_import.started");

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    const BATCH = 200;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (row) => {
          const phone = normalizePhone(row.phone);
          if (!phone) { skipped++; return; }
          try {
            await prisma.contact.upsert({
              where: { tenantId_phone: { tenantId, phone } },
              create: {
                tenantId, phone,
                ...(row.name !== undefined && { name: row.name }),
                ...(row.attributes !== undefined && { attributes: row.attributes as Prisma.InputJsonValue }),
              },
              update: {
                ...(row.name !== undefined && { name: row.name }),
                ...(row.attributes !== undefined && { attributes: row.attributes as Prisma.InputJsonValue }),
              },
            });
            imported++;
          } catch {
            skipped++;
          }
        })
      );
      await job.updateProgress(Math.round(((i + batch.length) / rows.length) * 100));
    }

    log.info({ jobId, imported, skipped }, "contact_import.done");
    return { imported, skipped, errors };
  },
  { connection, concurrency: 2 }
);

contactImportWorker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "contact_import.job.failed"));

// ── Purge / Monthly Billing Worker ───────────────────────────────────────
const purgeWorker = new Worker(
  QUEUES.PURGE,
  async (job) => {
    if (job.name !== JOBS.MONTHLY_FEE) {
      log.warn({ jobName: job.name }, "purge.unknown_job");
      return;
    }

    log.info({ jobId: job.id }, "monthly_fee.started");

    const result = await runMonthlyBilling();

    log.info({ jobId: job.id, ...result }, "monthly_fee.done");
  },
  { connection, concurrency: 1 }
);

purgeWorker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "purge.job.failed"));

// Schedule monthly fee job on 1st of each month at 02:00 UTC
const purgeQueue = new Queue(QUEUES.PURGE, { connection });
purgeQueue
  .add(JOBS.MONTHLY_FEE, {}, { repeat: { pattern: "0 2 1 * *" }, jobId: "monthly-fee-recurring" })
  .catch((err) => log.error({ err }, "purge.schedule_failed"));

// ── Graceful shutdown ─────────────────────────────────────────────────────
async function shutdown(signal: string) {
  log.info({ signal }, "worker.shutting_down");
  await Promise.all([
    callEngineWorker.close(),
    billingWorker.close(),
    webhooksOutWorker.close(),
    contactImportWorker.close(),
    purgeWorker.close(),
  ]);
  log.info("worker.stopped");
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(console.error); });
process.on("SIGINT", () => { shutdown("SIGINT").catch(console.error); });

callEngineWorker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "call_engine.job.failed"));
billingWorker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "billing.job.failed"));

log.info(`Falaí Worker started — queues: ${Object.values(QUEUES).join(", ")}`);
