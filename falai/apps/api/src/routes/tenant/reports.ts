import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { buildCallReport, reportToCsv } from "../../services/reports.service.js";

const rangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

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
};
