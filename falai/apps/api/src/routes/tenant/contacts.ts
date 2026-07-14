import type { FastifyPluginAsync } from "fastify";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { prisma } from "@falai/db";
import { z } from "zod";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { QUEUES, JOBS } from "@falai/shared";
import { config } from "../../config.js";

const createSchema = z.object({
  phone: z.string().min(7).max(20),
  name: z.string().max(100).optional(),
  attributes: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  name: z.string().max(100).optional(),
  attributes: z.record(z.unknown()).optional(),
});

/** Normalize phone to E.164 for Angola (+244XXXXXXXXX) */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("244") && digits.length === 12) return `+${digits}`;
  if (digits.length === 9) return `+244${digits}`; // local format
  if (digits.startsWith("00244") && digits.length === 14) return `+${digits.slice(2)}`;
  return null;
}

interface ContactRow {
  phone: string;
  name?: string;
  [key: string]: unknown;
}

function parseContactRows(rows: ContactRow[], tenantId: string): {
  valid: Array<{ phone: string; name?: string; attributes: Record<string, unknown>; tenantId: string }>;
  errors: Array<{ row: number; raw: string; reason: string }>;
} {
  const valid: Array<{ phone: string; name?: string; attributes: Record<string, unknown>; tenantId: string }> = [];
  const errors: Array<{ row: number; raw: string; reason: string }> = [];

  rows.forEach((row, i) => {
    const rawPhone = String(row["phone"] ?? row["telefone"] ?? row["numero"] ?? "").trim();
    if (!rawPhone) {
      errors.push({ row: i + 2, raw: "", reason: "Coluna 'phone' em falta" });
      return;
    }

    const normalized = normalizePhone(rawPhone);
    if (!normalized) {
      errors.push({ row: i + 2, raw: rawPhone, reason: "Formato de telefone inválido" });
      return;
    }

    const { phone: _p, name: _n, telefone: _t, numero: _num, ...extraAttrs } = row;
    valid.push({
      tenantId,
      phone: normalized,
      ...(row["name"] || row["nome"] ? { name: String(row["name"] ?? row["nome"] ?? "") } : {}),
      attributes: extraAttrs as Record<string, unknown>,
    });
  });

  return { valid, errors };
}

export const tenantContactsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/contacts
  fastify.get<{
    Querystring: { q?: string; limit?: string; offset?: string; optedOut?: string };
  }>("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const { q, limit = "100", offset = "0", optedOut } = request.query;

    const contacts = await prisma.contact.findMany({
      where: {
        tenantId,
        ...(q && {
          OR: [
            { phone: { contains: q } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        }),
        ...(optedOut === "true" && { optedOutAt: { not: null } }),
        ...(optedOut === "false" && { optedOutAt: null }),
      },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit, 10),
      skip: parseInt(offset, 10),
      select: {
        id: true,
        phone: true,
        name: true,
        attributes: true,
        optedOutAt: true,
        optOutReason: true,
        createdAt: true,
      },
    });

    const total = await prisma.contact.count({ where: { tenantId } });
    return { contacts, total };
  });

  // POST /tenant/contacts
  fastify.post("/", { preHandler }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { tenantId } = request.tenantUser!;

    const phone = normalizePhone(body.phone);
    if (!phone) return reply.status(400).send({ error: "Formato de telefone inválido. Use E.164 (+244XXXXXXXXX) ou formato local." });

    const contact = await prisma.contact.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: {
        tenantId,
        phone,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.attributes !== undefined && { attributes: body.attributes as object }),
      },
      update: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.attributes !== undefined && { attributes: body.attributes as object }),
      },
    });

    return reply.status(201).send({ contact });
  });

  // GET /tenant/contacts/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const contact = await prisma.contact.findFirst({
      where: { id: request.params.id, tenantId },
      include: { calls: { orderBy: { createdAt: "desc" }, take: 10, select: { id: true, status: true, outcome: true, durationSecs: true, createdAt: true } } },
    });
    if (!contact) return reply.status(404).send({ error: "Contacto não encontrado" });
    return { contact };
  });

  // PATCH /tenant/contacts/:id
  fastify.patch<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const body = updateSchema.parse(request.body);
    const { tenantId } = request.tenantUser!;

    const existing = await prisma.contact.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Contacto não encontrado" });

    const contact = await prisma.contact.update({
      where: { id: request.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.attributes !== undefined && { attributes: body.attributes as object }),
      },
    });

    return { contact };
  });

  // DELETE /tenant/contacts/:id
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const existing = await prisma.contact.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Contacto não encontrado" });

    await prisma.contact.delete({ where: { id: request.params.id } });
    return { ok: true };
  });

  // POST /tenant/contacts/:id/opt-out
  fastify.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>("/:id/opt-out", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    const contact = await prisma.contact.findFirst({ where: { id: request.params.id, tenantId } });
    if (!contact) return reply.status(404).send({ error: "Contacto não encontrado" });
    if (contact.optedOutAt) return reply.status(400).send({ error: "Contacto já está em opt-out" });

    const reason = (request.body as { reason?: string }).reason ?? "Solicitado pelo tenant";

    await prisma.contact.update({
      where: { id: contact.id },
      data: { optedOutAt: new Date(), optOutReason: reason },
    });

    return { ok: true };
  });

  // POST /tenant/contacts/import — CSV or XLSX upload
  // Files ≤ 500 rows: inline (synchronous). Files > 500 rows: async via BullMQ.
  fastify.post("/import", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;

    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "Pedido deve ser multipart/form-data com um campo 'file'" });
    }

    const data = await request.file();
    if (!data) return reply.status(400).send({ error: "Nenhum ficheiro enviado" });

    const fileName = data.filename.toLowerCase();
    const fileBuffer = await data.toBuffer();

    let rows: ContactRow[];

    try {
      if (fileName.endsWith(".csv")) {
        rows = csvParse(fileBuffer, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as ContactRow[];
      } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
        const workbook = XLSX.read(fileBuffer, { type: "buffer" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0] ?? ""] ?? {};
        rows = XLSX.utils.sheet_to_json<ContactRow>(firstSheet);
      } else {
        return reply.status(400).send({ error: "Formato não suportado. Usa .csv ou .xlsx" });
      }
    } catch {
      return reply.status(400).send({ error: "Erro ao analisar o ficheiro. Verifica o formato." });
    }

    const { valid, errors } = parseContactRows(rows, tenantId);

    const ASYNC_THRESHOLD = 500;

    if (valid.length > ASYNC_THRESHOLD) {
      // Enqueue for background processing
      const jobId = randomUUID();
      const importQueue = new Queue(QUEUES.CONTACT_IMPORT, { connection: { url: config.REDIS_URL } });
      await importQueue.add(
        JOBS.IMPORT_CONTACTS,
        {
          jobId,
          tenantId,
          rows: valid.map((c) => ({ phone: c.phone, ...(c.name !== undefined && { name: c.name }), ...(Object.keys(c.attributes as object).length > 0 && { attributes: c.attributes }) })),
        },
        { jobId }
      );
      await importQueue.close();

      return reply.status(202).send({
        async: true,
        jobId,
        totalRows: rows.length,
        validRows: valid.length,
        errors: errors.slice(0, 50),
        statusUrl: `/tenant/contacts/import/${jobId}`,
      });
    }

    // Inline for small files
    let imported = 0;
    let skipped = 0;

    const BATCH = 500;
    for (let i = 0; i < valid.length; i += BATCH) {
      const batch = valid.slice(i, i + BATCH);
      await Promise.all(
        batch.map((c) =>
          prisma.contact
            .upsert({
              where: { tenantId_phone: { tenantId, phone: c.phone } },
              create: {
                tenantId,
                phone: c.phone,
                ...(c.name !== undefined && { name: c.name }),
                attributes: c.attributes as object,
              },
              update: {
                ...(c.name !== undefined && { name: c.name }),
                attributes: c.attributes as object,
              },
            })
            .then(() => { imported++; })
            .catch(() => { skipped++; })
        )
      );
    }

    return {
      async: false,
      imported,
      skipped,
      errors: errors.slice(0, 50),
      totalRows: rows.length,
    };
  });

  // GET /tenant/contacts/import/:jobId — poll async import status
  fastify.get<{ Params: { jobId: string } }>("/import/:jobId", { preHandler }, async (request, reply) => {
    const importQueue = new Queue(QUEUES.CONTACT_IMPORT, { connection: { url: config.REDIS_URL } });
    const job = await importQueue.getJob(request.params.jobId);
    await importQueue.close();

    if (!job) return reply.status(404).send({ error: "Import job not found" });

    const state = await job.getState();
    const progress = job.progress;
    const returnValue = job.returnvalue as { imported: number; skipped: number } | null;

    return reply.send({
      jobId: job.id,
      state,
      progress,
      result: state === "completed" ? returnValue : null,
      failedReason: state === "failed" ? job.failedReason : null,
    });
  });
};
