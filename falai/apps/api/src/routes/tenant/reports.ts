import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildCallReport, reportToCsv } from "../../services/reports.service.js";
import {
  buildAttendanceReport,
  exportTable,
  listAttendanceCalls,
  tableToCsv,
  type AttendanceFilter,
} from "../../services/attendanceReport.service.js";
import { ensureCdrSynced } from "../../services/pbxCdr.service.js";
import { buildOverview } from "../../services/reportsOverview.service.js";
import { renderOverviewPdf } from "../../services/reportsPdf.service.js";
import { attendanceWorkbook, overviewWorkbook } from "../../services/excelExport.service.js";
import { prisma } from "@falai/db";

const rangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
    const name = `atendimento_${q.view}_${f.from.toISOString().slice(0, 10)}_${f.to.toISOString().slice(0, 10)}`;
    if (q.format === "xlsx") {
      // Excel já formatado (exceljs) — ver services/excelExport.service.ts.
      const report = await buildAttendanceReport(tenantId, f, { limited: isCrmPbx });
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
      return reply
        .header("Content-Type", XLSX_TYPE)
        .header("Content-Disposition", `attachment; filename="${name}.xlsx"`)
        .send(await attendanceWorkbook(report, q.view, tenant.name));
    }
    const table = exportTable(await buildAttendanceReport(tenantId, f, { limited: isCrmPbx }), q.view);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${name}.csv"`)
      .send(tableToCsv(table));
  });

  // ── Resumo (painel com comparação ao período anterior) ─────────────────────

  // GET /tenant/reports/overview — cartões, anéis e chamadas por dia
  fastify.get("/tenant/reports/overview", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const { attendance: _a, calls: _c, ...overview } = await buildOverview(fastify, tenantId, resolveRange(rangeSchema.parse(request.query)));
    return overview;
  });

  // GET /tenant/reports/overview.xlsx — o Resumo em Excel formatado, com várias folhas
  fastify.get("/tenant/reports/overview.xlsx", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const range = resolveRange(rangeSchema.parse(request.query));
    const [overview, tenant] = await Promise.all([
      buildOverview(fastify, tenantId, range),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    ]);
    const name = `relatorio_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.xlsx`;
    return reply
      .header("Content-Type", XLSX_TYPE)
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .send(await overviewWorkbook(overview, overview.calls.rows, tenant.name));
  });

  // GET /tenant/reports/overview.pdf — o mesmo resumo num PDF a sério
  fastify.get("/tenant/reports/overview.pdf", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const range = resolveRange(rangeSchema.parse(request.query));
    const [overview, tenant] = await Promise.all([
      buildOverview(fastify, tenantId, range),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    ]);
    const pdf = await renderOverviewPdf(overview, tenant.name);
    const name = `relatorio_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.pdf`;
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .send(pdf);
  });
};
