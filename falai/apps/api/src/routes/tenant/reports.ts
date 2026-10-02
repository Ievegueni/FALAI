import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as XLSX from "xlsx";
import { buildCallReport, reportToCsv } from "../../services/reports.service.js";
import {
  buildAttendanceReport,
  exportTable,
  listAttendanceCalls,
  tableToCsv,
  type AttendanceFilter,
} from "../../services/attendanceReport.service.js";
import { ensureCdrSynced } from "../../services/pbxCdr.service.js";

const rangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Relatórios de atendimento: período + agente (extensão) + grupo.
const attendanceSchema = rangeSchema.extend({
  extensionId: z.string().optional(),
  groupId: z.string().optional(),
  categoryId: z.string().optional(),
});
const callsListSchema = attendanceSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const exportSchema = attendanceSchema.extend({
  view: z.enum(["agents", "groups", "reasons", "typing"]).default("agents"),
  format: z.enum(["csv", "xlsx"]).default("csv"),
});

function attendanceFilter(q: z.infer<typeof attendanceSchema>): AttendanceFilter {
  return { ...resolveRange(q), extensionId: q.extensionId, groupId: q.groupId, categoryId: q.categoryId };
}

/** Resolve o intervalo pedido; por omissão, os últimos 30 dias. */
function resolveRange(q: { from?: string | undefined; to?: string | undefined }): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
  // Inclui o dia inteiro do limite superior
  to.setHours(23, 59, 59, 999);
  from.setHours(0, 0, 0, 0);
  return { from, to };
}

export const tenantReportsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/reports — resumo agregado por intervalo (sem as linhas em bruto)
  fastify.get<{ Querystring: { from?: string; to?: string } }>("/tenant/reports", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const range = resolveRange(rangeSchema.parse(request.query));
    const report = await buildCallReport(fastify, tenantId, range);
    const { rows: _rows, ...summary } = report;
    return summary;
  });

  // GET /tenant/reports/calls.csv — exportação da lista de chamadas do intervalo
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    "/tenant/reports/calls.csv",
    { preHandler },
    async (request, reply) => {
      const { tenantId } = request.tenantUser!;
      const range = resolveRange(rangeSchema.parse(request.query));
      const report = await buildCallReport(fastify, tenantId, range);
      const csv = reportToCsv(report);
      const filename = `chamadas_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.csv`;
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(csv);
    }
  );

  // ── Atendimento (KPIs por agente/grupo) ────────────────────────────────────

  // GET /tenant/reports/attendance — KPIs do tenant, da selecção (agente/grupo),
  // por agente, por grupo e motivos de recusa, com a diferença para a média.
  fastify.get("/tenant/reports/attendance", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const q = attendanceSchema.parse(request.query);
    const { isCrmPbx } = await ensureCdrSynced(fastify, tenantId);
    return buildAttendanceReport(tenantId, attendanceFilter(q), { limited: isCrmPbx });
  });

  // GET /tenant/reports/attendance/calls — chamadas de entrada com as pernas (paginado)
  fastify.get("/tenant/reports/attendance/calls", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const q = callsListSchema.parse(request.query);
    return listAttendanceCalls(tenantId, attendanceFilter(q), q.page, q.pageSize);
  });

  // GET /tenant/reports/attendance/export?view=agents|groups|reasons&format=csv|xlsx
  fastify.get("/tenant/reports/attendance/export", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const q = exportSchema.parse(request.query);
    const f = attendanceFilter(q);
    const { isCrmPbx } = await ensureCdrSynced(fastify, tenantId);
    const table = exportTable(await buildAttendanceReport(tenantId, f, { limited: isCrmPbx }), q.view);
    const name = `atendimento_${q.view}_${f.from.toISOString().slice(0, 10)}_${f.to.toISOString().slice(0, 10)}`;
    if (q.format === "xlsx") {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(table), q.view);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="${name}.xlsx"`)
        .send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    }
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${name}.csv"`)
      .send(tableToCsv(table));
  });
};
