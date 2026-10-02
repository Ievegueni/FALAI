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
import { ClaudeAdapter } from "@falai/providers";
import { config } from "../../config.js";
import {
  AnalysisError,
  latestAnalysis,
  prepareAnalysisInput,
  runAnalysis,
  usedToday,
  agentRef,
  type AnalysisFilters,
} from "../../services/reportAnalysis.service.js";
import { previousRange } from "../../services/reportsOverview.service.js";

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

/** Filtros da análise IA tal como o ecrã os tem (dias locais AAAA-MM-DD). */
function analysisFilters(q: z.infer<typeof attendanceSchema>): AnalysisFilters {
  const r = resolveRange(q);
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: day(r.from), to: day(r.to), extensionId: q.extensionId || undefined, groupId: q.groupId || undefined, categoryId: q.categoryId || undefined };
}

const ANALYSIS_ADMINS = new Set(["OWNER", "ADMIN"]);

export const tenantReportsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // ── Análise com IA (melhoria 6) ────────────────────────────────────────────
  // Claude da plataforma (mesma chave/configuração das chamadas). Sem chave ou
  // com AI_STUB_MODE responde em modo de teste, sem gastar tokens.
  const llm = new ClaudeAdapter({
    apiKey: fastify.providerConfig.anthropic.apiKey,
    model: config.AI_REPORT_MODEL,
    stubMode: config.AI_STUB_MODE || !fastify.providerConfig.anthropic.apiKey,
  });

  /**
   * Quem pode analisar e o quê: owner/admin tudo; supervisor só com um dos
   * grupos dele (ou um agente desses grupos) e só vê esses agentes.
   */
  async function analysisScope(userId: string, role: string, tenantId: string, f: AnalysisFilters) {
    if (ANALYSIS_ADMINS.has(role)) return { ok: true as const, allowed: undefined, wholeTenant: !f.extensionId && !f.groupId && !f.categoryId };
    if (role !== "SUPERVISOR") return { ok: false as const, error: "A análise com IA está disponível para supervisores e administradores." };
    const groups = (await prisma.supervisorGroup.findMany({ where: { tenantUserId: userId, group: { tenantId } }, select: { groupId: true } })).map((g) => g.groupId);
    const members = await prisma.extensionGroupMember.findMany({ where: { groupId: { in: groups } }, select: { extensionId: true } });
    const allowed = new Set(members.map((m) => m.extensionId));
    const okGroup = f.groupId && groups.includes(f.groupId);
    const okAgent = f.extensionId && allowed.has(f.extensionId);
    if (!okGroup && !okAgent) return { ok: false as const, error: "Escolha um dos seus grupos (ou um agente deles) no filtro para analisar." };
    if (f.groupId && !okGroup) return { ok: false as const, error: "Esse grupo não lhe está atribuído." };
    if (f.extensionId && !okAgent) return { ok: false as const, error: "Esse agente não pertence aos seus grupos." };
    return { ok: true as const, allowed, wholeTenant: false };
  }

  // GET /tenant/reports/analysis — última análise destes filtros + uso do dia
  fastify.get("/tenant/reports/analysis", { preHandler }, async (request) => {
    const { tenantId, role } = request.tenantUser!;
    const f = analysisFilters(attendanceSchema.parse(request.query));
    const [analysis, tenant, used] = await Promise.all([
      latestAnalysis(tenantId, f),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { aiReportDailyLimit: true, aiReportAgentNames: true } }),
      usedToday(tenantId),
    ]);
    return {
      analysis,
      canAnalyze: ANALYSIS_ADMINS.has(role) || role === "SUPERVISOR",
      canConfigure: ANALYSIS_ADMINS.has(role),
      agentNames: tenant.aiReportAgentNames,
      dailyLimit: tenant.aiReportDailyLimit,
      usedToday: used,
    };
  });

  // POST /tenant/reports/analysis — analisa o resumo dos filtros activos
  fastify.post("/tenant/reports/analysis", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    const q = attendanceSchema.parse(request.body ?? {});
    const f = analysisFilters(q);
    const scope = await analysisScope(sub, role, tenantId, f);
    if (!scope.ok) return reply.status(403).send({ error: scope.error });

    const range = resolveRange(q);
    const prev = previousRange(range.from, range.to);
    const { isCrmPbx } = await ensureCdrSynced(fastify, tenantId);
    const sel = { extensionId: f.extensionId, groupId: f.groupId, categoryId: f.categoryId };
    const [cur, before, tenant, overview, group, category, ext] = await Promise.all([
      buildAttendanceReport(tenantId, { ...range, ...sel }, { limited: isCrmPbx }),
      buildAttendanceReport(tenantId, { ...prev, ...sel }, { limited: isCrmPbx }),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { aiReportDailyLimit: true, aiReportAgentNames: true } }),
      scope.wholeTenant ? buildOverview(fastify, tenantId, range) : Promise.resolve(undefined),
      f.groupId ? prisma.extensionGroup.findFirst({ where: { id: f.groupId, tenantId }, select: { name: true } }) : null,
      f.categoryId ? prisma.callCategory.findFirst({ where: { id: f.categoryId, tenantId }, select: { name: true } }) : null,
      f.extensionId ? prisma.extension.findFirst({ where: { id: f.extensionId, tenantId }, select: { number: true, displayName: true } }) : null,
    ]);
    const input = prepareAnalysisInput(cur, before, f, {
      scope: {
        agent: ext ? agentRef({ number: ext.number, name: ext.displayName }, tenant.aiReportAgentNames) : null,
        group: group?.name ?? null,
        typing: category?.name ?? null,
      },
      agentNames: tenant.aiReportAgentNames,
      allowedExtensionIds: scope.allowed,
      overview,
    });
    try {
      return await runAnalysis({ tenantId, userId: sub, filters: f, input, llm, model: config.AI_REPORT_MODEL, dailyLimit: tenant.aiReportDailyLimit });
    } catch (e) {
      if (e instanceof AnalysisError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  });

  // PUT /tenant/reports/analysis/settings — enviar ou não o nome dos agentes à IA
  fastify.put("/tenant/reports/analysis/settings", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!ANALYSIS_ADMINS.has(role)) return reply.status(403).send({ error: "Só administradores podem alterar esta opção." });
    const body = z.object({ agentNames: z.boolean() }).parse(request.body);
    await prisma.tenant.update({ where: { id: tenantId }, data: { aiReportAgentNames: body.agentNames } });
    return { ok: true };
  });

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
      const [report, tenant, analysis] = await Promise.all([
        buildAttendanceReport(tenantId, f, { limited: isCrmPbx }),
        prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
        latestAnalysis(tenantId, analysisFilters(q)),
      ]);
      return reply
        .header("Content-Type", XLSX_TYPE)
        .header("Content-Disposition", `attachment; filename="${name}.xlsx"`)
        .send(await attendanceWorkbook(report, q.view, tenant.name, analysis));
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
    // Os filtros de agente/grupo/tipificação só servem para juntar a análise IA desses filtros.
    const q = attendanceSchema.parse(request.query);
    const range = resolveRange(q);
    const [overview, tenant, analysis] = await Promise.all([
      buildOverview(fastify, tenantId, range),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
      latestAnalysis(tenantId, analysisFilters(q)),
    ]);
    const name = `relatorio_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.xlsx`;
    return reply
      .header("Content-Type", XLSX_TYPE)
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .send(await overviewWorkbook(overview, overview.calls.rows, tenant.name, analysis));
  });

  // GET /tenant/reports/overview.pdf — o mesmo resumo num PDF a sério
  fastify.get("/tenant/reports/overview.pdf", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const q = attendanceSchema.parse(request.query);
    const range = resolveRange(q);
    const [overview, tenant, analysis] = await Promise.all([
      buildOverview(fastify, tenantId, range),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
      latestAnalysis(tenantId, analysisFilters(q)),
    ]);
    const pdf = await renderOverviewPdf(overview, tenant.name, analysis);
    const name = `relatorio_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.pdf`;
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .send(pdf);
  });
};
