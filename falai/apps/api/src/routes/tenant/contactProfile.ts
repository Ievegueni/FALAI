import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import ExcelJS from "exceljs";
import { prisma } from "@falai/db";
import { normalizeAoPhone } from "@falai/shared";
import {
  buildProfile,
  historyFilterSchema,
  historySelect,
  historyWhere,
  mapHistoryRow,
  mergeContacts,
  MergeError,
} from "../../services/contactProfile.service.js";
import { phoneOwner } from "../../services/callerLookup.service.js";
import { addTableSheet } from "../../services/excelExport.service.js";

/**
 * Perfil completo do cliente (melhoria 5/6) — ver services/contactProfile.service.ts.
 * Registado em /tenant/contacts (feature "contacts"). Ler: agente, supervisor,
 * admin e leitor; editar: todos menos o leitor; unir duplicados: supervisor,
 * admin e owner. Cada consulta fica no AuditLog (contact.history_viewed),
 * como na melhoria 3.
 */

const phoneSchema = z.object({ phone: z.string().min(6).max(30), label: z.string().trim().max(40).optional() });
const mergeSchema = z.object({ otherId: z.string().min(1) });
const MERGE_ROLES = new Set(["OWNER", "ADMIN", "SUPERVISOR"]);
const INVALID_PHONE = "Número inválido. Use o formato nacional de 9 dígitos (ex: 923 456 789).";

const STATE_PT: Record<string, string> = { ANSWERED: "Atendida", MISSED: "Perdida", REJECTED: "Recusada", IN_PROGRESS: "Em curso" };

export const tenantContactProfileRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  const viewed = (request: FastifyRequest, contactId: string, after: Record<string, unknown>) =>
    fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      tenantId: request.tenantUser!.tenantId,
      action: "contact.history_viewed",
      targetType: "Contact",
      targetId: contactId,
      after,
      ip: request.ip,
    });

  const canEdit = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.tenantUser!.role !== "VIEWER") return true;
    void reply.status(403).send({ error: "O perfil Leitor só pode consultar" });
    return false;
  };

  const owns = (tenantId: string, id: string) => prisma.contact.count({ where: { id, tenantId } }).then((n) => n > 0);

  // GET /tenant/contacts/:id/profile — cabeçalho, resumo, tipificações e notas
  fastify.get<{ Params: { id: string } }>("/:id/profile", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const profile = await buildProfile(tenantId, request.params.id);
    if (!profile) return reply.status(404).send({ error: "Contacto não encontrado" });
    await viewed(request, request.params.id, { via: "profile" });
    return profile;
  });

  // GET /tenant/contacts/:id/calls — histórico completo, filtrado e paginado
  fastify.get<{ Params: { id: string } }>("/:id/calls", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const f = historyFilterSchema.parse(request.query);
    if (!(await owns(tenantId, request.params.id))) return reply.status(404).send({ error: "Contacto não encontrado" });
    const where = historyWhere(tenantId, request.params.id, f);
    const [rows, total] = await Promise.all([
      prisma.call.findMany({ where, orderBy: { startedAt: "desc" }, skip: (f.page - 1) * f.pageSize, take: f.pageSize, select: historySelect }),
      prisma.call.count({ where }),
    ]);
    return { data: rows.map(mapHistoryRow), total, page: f.page, pageSize: f.pageSize };
  });

  // GET /tenant/contacts/:id/calls/export.xlsx — o mesmo histórico filtrado em Excel
  fastify.get<{ Params: { id: string } }>("/:id/calls/export.xlsx", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const f = historyFilterSchema.parse(request.query);
    const contact = await prisma.contact.findFirst({ where: { id: request.params.id, tenantId }, select: { name: true, phone: true } });
    if (!contact) return reply.status(404).send({ error: "Contacto não encontrado" });
    const MAX = 20_000; // ponytail: limite de linhas por exportação (igual à página Chamadas)
    const rows = await prisma.call.findMany({ where: historyWhere(tenantId, request.params.id, f), orderBy: { startedAt: "desc" }, take: MAX, select: historySelect });
    await viewed(request, request.params.id, { via: "export" });

    const who = contact.name || contact.phone || "Cliente";
    const period = f.from || f.to ? `${f.from ?? "…"} – ${f.to ?? "…"}` : "todo o histórico";
    const wb = new ExcelJS.Workbook();
    wb.creator = "Falaí";
    addTableSheet(wb, "Histórico", `Histórico de ${who}`, `${period} · ${rows.length} chamadas · gerado em ${new Date().toLocaleString("pt-PT")}`, [
      { header: "Data", width: 17, fmt: "datetime" },
      { header: "Direcção", width: 10, fmt: "text" },
      { header: "Agente", width: 22, fmt: "text" },
      { header: "Grupo", width: 14, fmt: "text" },
      { header: "Duração", width: 10, fmt: "secs" },
      { header: "Estado", width: 11, fmt: "text" },
      { header: "Tipificação", width: 28, fmt: "text" },
      { header: "Nota", width: 40, fmt: "text" },
    ], rows.map((r) => {
      const c = mapHistoryRow(r);
      return [c.at, c.direction === "INBOUND" ? "Entrada" : "Saída", c.agent, c.group, c.durationSecs, STATE_PT[c.state] ?? c.state, c.typing, c.note];
    }));
    const slug = who.normalize("NFD").replace(/[^\w]+/g, "_").toLowerCase();
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="historico_${slug}_${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  // POST /tenant/contacts/:id/phones — número extra
  fastify.post<{ Params: { id: string } }>("/:id/phones", { preHandler }, async (request, reply) => {
    if (!canEdit(request, reply)) return;
    const { tenantId } = request.tenantUser!;
    const body = phoneSchema.parse(request.body);
    const phone = normalizeAoPhone(body.phone);
    if (!phone) return reply.status(400).send({ error: INVALID_PHONE });
    if (!(await owns(tenantId, request.params.id))) return reply.status(404).send({ error: "Contacto não encontrado" });
    const owner = await phoneOwner(tenantId, phone);
    if (owner) {
      return reply.status(409).send({
        error: owner === request.params.id ? "O contacto já tem este número" : "Este número já pertence a outro contacto",
        contactId: owner,
      });
    }
    const row = await prisma.contactPhone.create({
      data: { tenantId, contactId: request.params.id, phone, ...(body.label && { label: body.label }) },
      select: { id: true, phone: true, label: true },
    });
    return reply.status(201).send(row);
  });

  // DELETE /tenant/contacts/:id/phones/:phoneId
  fastify.delete<{ Params: { id: string; phoneId: string } }>("/:id/phones/:phoneId", { preHandler }, async (request, reply) => {
    if (!canEdit(request, reply)) return;
    const { tenantId } = request.tenantUser!;
    const res = await prisma.contactPhone.deleteMany({ where: { id: request.params.phoneId, contactId: request.params.id, tenantId } });
    if (res.count === 0) return reply.status(404).send({ error: "Número não encontrado" });
    return reply.status(204).send();
  });

  // POST /tenant/contacts/:id/merge { otherId } — o outro é absorvido por este
  fastify.post<{ Params: { id: string } }>("/:id/merge", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!MERGE_ROLES.has(role)) return reply.status(403).send({ error: "Só supervisores e administradores podem unir contactos" });
    const { otherId } = mergeSchema.parse(request.body);
    try {
      const res = await prisma.$transaction((tx) => mergeContacts(tx, tenantId, request.params.id, otherId), { timeout: 30_000 });
      await fastify.audit({
        actorType: "TENANT_USER",
        actorId: sub,
        tenantId,
        action: "contact.merged",
        targetType: "Contact",
        targetId: request.params.id,
        before: res.dropped, // snapshot do contacto apagado
        after: { mergedFrom: otherId, moved: res.moved },
        ip: request.ip,
      });
      return { ok: true, moved: res.moved };
    } catch (e) {
      if (e instanceof MergeError) return reply.status(400).send({ error: e.message });
      throw e;
    }
  });
};
