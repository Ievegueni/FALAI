import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma, prisma } from "@falai/db";
import {
  ANSWERS,
  QaError,
  agentOf,
  applyAutoCriteria,
  cleanAnswers,
  normalizeDefinition,
  qaReport,
  qaSample,
  scoreEvaluation,
  type FormDefinition,
} from "../../services/quality.service.js";
import { runAiAudit } from "../../services/qaAi.service.js";
import { emitWebhookAsync } from "../../services/webhookEmitter.service.js";
import { isOpsManager, userScope, type UserScope } from "../../services/userScope.js";

/**
 * Qualidade (fase 7) — ver services/quality.service.ts.
 *   Formulários: gestor/admin.
 *   Avaliar: gestor/admin todos; supervisor os agentes da equipa; ninguém a si.
 *   Ver: agente as suas; supervisor as da equipa; gestor/admin/consulta todas.
 *   Agente: confirma a leitura ou contesta. Avaliador/gestor revê (fica no AuditLog).
 *   Auditor: grelhas, avalia e revê qualquer agente, e trata os rascunhos da IA
 *   (AI_DRAFT, ver services/qaAi.service.ts), que o agente não vê até serem submetidos.
 */

const answersSchema = z.record(z.string(), z.enum(ANSWERS));
const formSchema = z.object({ name: z.string().trim().min(1).max(120), definition: z.unknown(), isActive: z.boolean().optional() });
const createSchema = z
  .object({
    formId: z.string(),
    callId: z.string().optional(),
    conversationId: z.string().optional(),
    ticketId: z.string().optional(),
    agentId: z.string().optional(), // por omissão, quem atendeu / o responsável
    answers: answersSchema,
    comment: z.string().trim().max(5000).optional(),
  })
  .refine((b) => [b.callId, b.conversationId, b.ticketId].filter(Boolean).length === 1, "Indique a chamada, a conversa ou o ticket avaliado");
const patchSchema = z.object({
  answers: answersSchema.optional(),
  comment: z.string().trim().max(5000).nullable().optional(),
  resolution: z.string().trim().min(1).max(5000).optional(),
});
const submitSchema = z.object({ answers: answersSchema, comment: z.string().trim().max(5000).optional() });
const aiSettingsSchema = z.object({
  formId: z.string().nullable(),
  samplePct: z.number().int().min(0).max(100),
  forbiddenWords: z.array(z.string().trim().min(1).max(60)).max(200).optional(),
  alertThreshold: z.number().int().min(0).max(100).optional(),
});
const agentNoteSchema = z.object({ comment: z.string().trim().max(5000).optional() });
const listQuery = z.object({
  agentId: z.string().optional(),
  status: z.enum(["AI_DRAFT", "SUBMITTED", "ACKNOWLEDGED", "DISPUTED", "RESOLVED"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

/** Avaliações visíveis por âmbito. */
function evalScopeWhere(scope: UserScope): Prisma.QaEvaluationWhereInput {
  if (scope.kind === "ALL") return {};
  if (scope.kind === "SELF") return { agentId: scope.userId, status: { not: "AI_DRAFT" } };
  return { OR: [{ agentId: { in: scope.userIds } }, { evaluatorId: scope.userId }] };
}

const range = (from?: string, to?: string): Prisma.DateTimeFilter | undefined =>
  from || to
    ? { ...(from && { gte: new Date(`${from}T00:00:00`) }), ...(to && { lte: new Date(`${to}T23:59:59.999`) }) }
    : undefined;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof QaError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

const evalInclude = {
  agent: { select: { id: true, name: true } },
  evaluator: { select: { id: true, name: true } },
} satisfies Prisma.QaEvaluationInclude;

export const tenantQualityRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];
  const canEvaluate = (role: string) => isOpsManager(role) || role === "SUPERVISOR" || role === "AUDITOR";
  /** Grelhas, configuração da IA e rever avaliações de outros. */
  const isQaAdmin = (role: string) => isOpsManager(role) || role === "AUDITOR";
  const audit = (request: FastifyRequest, action: string, targetId: string, before?: unknown, after?: unknown) =>
    fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      tenantId: request.tenantUser!.tenantId,
      action,
      targetType: "QaEvaluation",
      targetId,
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
      ip: request.ip,
    });

  // ── Formulários ────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { all?: string } }>("/tenant/qa/forms", { preHandler }, async (request) => {
    const data = await prisma.qaForm.findMany({
      where: { tenantId: request.tenantUser!.tenantId, ...(request.query.all ? {} : { isActive: true }) },
      orderBy: { name: "asc" },
    });
    return { data };
  });

  fastify.post("/tenant/qa/forms", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isQaAdmin(role)) return reply.status(403).send({ error: "Apenas administradores, gestores ou auditores" });
    const body = formSchema.parse(request.body);
    const row = await prisma.qaForm
      .create({ data: { tenantId, name: body.name, definition: normalizeDefinition(body.definition) } })
      .catch(() => null);
    if (!row) return reply.status(409).send({ error: "Já existe um formulário com esse nome" });
    return reply.status(201).send(row);
  });

  fastify.put<{ Params: { id: string } }>("/tenant/qa/forms/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isQaAdmin(role)) return reply.status(403).send({ error: "Apenas administradores, gestores ou auditores" });
    const body = formSchema.parse(request.body);
    const res = await prisma.qaForm
      .updateMany({
        where: { id: request.params.id, tenantId },
        data: { name: body.name, definition: normalizeDefinition(body.definition), ...(body.isActive !== undefined && { isActive: body.isActive }) },
      })
      .catch(() => null);
    if (!res) return reply.status(409).send({ error: "Já existe um formulário com esse nome" });
    if (res.count === 0) return reply.status(404).send({ error: "Formulário não encontrado" });
    return prisma.qaForm.findUnique({ where: { id: request.params.id } });
  });

  // ── Avaliações ─────────────────────────────────────────────────────────────
  fastify.get("/tenant/qa/evaluations", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const q = listQuery.parse(request.query);
    const created = range(q.from, q.to);
    const where: Prisma.QaEvaluationWhereInput = {
      tenantId,
      AND: [evalScopeWhere(await userScope(request.tenantUser!))], // em AND: o filtro de estado não pode desfazer o âmbito
      ...(q.agentId && { agentId: q.agentId }),
      ...(q.status && { status: q.status }),
      ...(created && { createdAt: created }),
    };
    const [data, total] = await Promise.all([
      prisma.qaEvaluation.findMany({
        where,
        // Por rever: primeiro os eliminatórios e as notas mais baixas.
        orderBy: q.status === "AI_DRAFT" ? [{ criticalFail: "desc" }, { score: "asc" }, { createdAt: "asc" }] : { createdAt: "desc" },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
        select: {
          id: true, score: true, criticalFail: true, status: true, createdAt: true, callId: true, conversationId: true, ticketId: true,
          form: { select: { name: true } }, ...evalInclude,
        },
      }),
      prisma.qaEvaluation.count({ where }),
    ]);
    return { data, total, page: q.page, perPage: q.perPage };
  });

  // GET /tenant/qa/summary — QA score médio por agente no período
  fastify.get("/tenant/qa/summary", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const q = listQuery.parse(request.query);
    const created = range(q.from, q.to);
    const where: Prisma.QaEvaluationWhereInput = {
      tenantId,
      AND: [evalScopeWhere(await userScope(request.tenantUser!))],
      ...(created && { createdAt: created }),
      status: { not: "AI_DRAFT" },
    };
    const [groups, critical, disputed] = await Promise.all([
      prisma.qaEvaluation.groupBy({ by: ["agentId"], where, _avg: { score: true }, _count: { _all: true } }),
      prisma.qaEvaluation.groupBy({ by: ["agentId"], where: { ...where, criticalFail: true }, _count: { _all: true } }),
      prisma.qaEvaluation.groupBy({ by: ["agentId"], where: { ...where, status: "DISPUTED" }, _count: { _all: true } }),
    ]);
    const names = new Map((await prisma.tenantUser.findMany({ where: { id: { in: groups.map((g) => g.agentId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const count = (list: typeof critical, id: string) => list.find((g) => g.agentId === id)?._count._all ?? 0;
    return {
      data: groups
        .map((g) => ({
          agentId: g.agentId,
          agent: names.get(g.agentId) ?? "—",
          evaluations: g._count._all,
          avgScore: g._avg.score === null ? null : Math.round(g._avg.score * 10) / 10,
          criticalFails: count(critical, g.agentId),
          disputed: count(disputed, g.agentId),
        }))
        .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0)),
    };
  });

  // GET /tenant/qa/report — por critério (pelo nome) e evolução semanal
  fastify.get("/tenant/qa/report", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const q = listQuery.parse(request.query);
    const created = range(q.from, q.to);
    // ponytail: agrega em memória as últimas 5000 — passar a SQL se o volume crescer.
    const rows = await prisma.qaEvaluation.findMany({
      where: { tenantId, AND: [evalScopeWhere(await userScope(request.tenantUser!))], status: { not: "AI_DRAFT" }, ...(created && { createdAt: created }) },
      orderBy: { createdAt: "desc" },
      take: 5000,
      select: { createdAt: true, score: true, answers: true, formSnapshot: true },
    });
    return qaReport(rows);
  });

  // GET /tenant/qa/sample — interacções por avaliar (aleatórias por agente)
  fastify.get<{ Querystring: { days?: string; perAgent?: string } }>("/tenant/qa/sample", { preHandler }, async (request, reply) => {
    if (!canEvaluate(request.tenantUser!.role)) return reply.status(403).send({ error: "Só supervisão avalia" });
    const days = Math.min(Math.max(Number(request.query.days) || 7, 1), 90);
    const perAgent = Math.min(Math.max(Number(request.query.perAgent) || 2, 1), 20);
    return { data: await qaSample(request.tenantUser!.tenantId, await userScope(request.tenantUser!), days, perAgent) };
  });

  fastify.get<{ Params: { id: string } }>("/tenant/qa/evaluations/:id", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    const ev = await prisma.qaEvaluation.findFirst({
      where: { id: request.params.id, tenantId: user.tenantId, ...evalScopeWhere(await userScope(user)) },
      include: { ...evalInclude, form: { select: { name: true } } },
    });
    if (!ev) return reply.status(404).send({ error: "Avaliação não encontrada" });
    return {
      ...ev,
      canEdit: ev.status === "AI_DRAFT" ? canEvaluate(user.role) && ev.agentId !== user.sub : ev.evaluatorId === user.sub || isQaAdmin(user.role),
      isMine: ev.agentId === user.sub,
    };
  });

  fastify.post("/tenant/qa/evaluations", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    if (!canEvaluate(user.role)) return reply.status(403).send({ error: "Só supervisão avalia" });
    const body = createSchema.parse(request.body);
    try {
      const form = await prisma.qaForm.findFirst({ where: { id: body.formId, tenantId: user.tenantId, isActive: true } });
      if (!form) throw new QaError(400, "Formulário inválido");
      const def = form.definition as FormDefinition;
      const agentId = body.agentId ?? (await agentOf(user.tenantId, body));
      if (!agentId) throw new QaError(400, "Não se sabe quem foi o agente — escolha-o");
      if (agentId === user.sub) throw new QaError(403, "Não pode avaliar-se a si próprio");
      const scope = await userScope(user);
      if (scope.kind !== "ALL" && !scope.userIds.includes(agentId)) throw new QaError(403, "Esse agente não é da sua equipa");
      if (!(await prisma.tenantUser.count({ where: { id: agentId, tenantId: user.tenantId } }))) throw new QaError(400, "Agente inválido");
      const answers = await applyAutoCriteria(user.tenantId, def, body.answers, body.callId);
      const { score, criticalFail } = scoreEvaluation(def, answers);
      const ev = await prisma.qaEvaluation.create({
        data: {
          tenantId: user.tenantId,
          formId: form.id,
          formSnapshot: { name: form.name, ...def },
          callId: body.callId ?? null,
          conversationId: body.conversationId ?? null,
          ticketId: body.ticketId ?? null,
          agentId,
          evaluatorId: user.sub,
          answers: cleanAnswers(def, answers),
          score,
          criticalFail,
          comment: body.comment ?? null,
        },
      });
      await audit(request, "tenant.qa.evaluated", ev.id, undefined, { score, criticalFail, agentId });
      await checkQaStreak(user.tenantId, agentId);
      return reply.status(201).send(ev);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // PATCH — o avaliador (ou gestor/admin) revê respostas/comentário ou responde à contestação
  fastify.patch<{ Params: { id: string } }>("/tenant/qa/evaluations/:id", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    const body = patchSchema.parse(request.body);
    const ev = await prisma.qaEvaluation.findFirst({ where: { id: request.params.id, tenantId: user.tenantId } });
    if (!ev) return reply.status(404).send({ error: "Avaliação não encontrada" });
    if (ev.status === "AI_DRAFT") return reply.status(409).send({ error: "Rascunho da IA — reveja e submeta" });
    if (ev.evaluatorId !== user.sub && !isQaAdmin(user.role)) return reply.status(403).send({ error: "Só quem avaliou, um gestor ou um auditor a pode rever" });
    try {
      const def = ev.formSnapshot as unknown as FormDefinition;
      const answers = body.answers && (await applyAutoCriteria(user.tenantId, def, body.answers, ev.callId));
      const scored = answers ? scoreEvaluation(def, answers) : null;
      const data: Prisma.QaEvaluationUpdateInput = {
        ...(answers && { answers: cleanAnswers(def, answers), score: scored!.score, criticalFail: scored!.criticalFail }),
        ...(body.comment !== undefined && { comment: body.comment }),
        ...(body.resolution && { resolution: body.resolution, ...(ev.status === "DISPUTED" && { status: "RESOLVED" as const }) }),
      };
      const updated = await prisma.qaEvaluation.update({ where: { id: ev.id }, data });
      await audit(
        request,
        "tenant.qa.revised",
        ev.id,
        { answers: ev.answers, score: ev.score, comment: ev.comment, status: ev.status },
        { answers: updated.answers, score: updated.score, comment: updated.comment, status: updated.status, resolution: updated.resolution }
      );
      if (answers) await checkQaStreak(user.tenantId, ev.agentId);
      return updated;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── Auditoria com IA ───────────────────────────────────────────────────────
  fastify.get("/tenant/qa/ai/settings", { preHandler }, async (request) => {
    const t = await prisma.tenant.findUniqueOrThrow({
      where: { id: request.tenantUser!.tenantId },
      select: { qaAiFormId: true, qaAiSamplePct: true, qaAiPricePerMinCents: true, qaForbiddenWords: true, qaAlertThreshold: true },
    });
    return {
      formId: t.qaAiFormId,
      samplePct: t.qaAiSamplePct,
      pricePerMinCents: t.qaAiPricePerMinCents,
      forbiddenWords: t.qaForbiddenWords,
      alertThreshold: t.qaAlertThreshold,
    };
  });

  fastify.put("/tenant/qa/ai/settings", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isQaAdmin(role)) return reply.status(403).send({ error: "Apenas administradores, gestores ou auditores" });
    const body = aiSettingsSchema.parse(request.body);
    if (body.formId && !(await prisma.qaForm.count({ where: { id: body.formId, tenantId, isActive: true } }))) {
      return reply.status(400).send({ error: "Grelha inválida" });
    }
    if (body.samplePct > 0 && !body.formId) return reply.status(400).send({ error: "Escolha a grelha antes de ligar a auditoria automática" });
    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { qaAiFormId: true, qaAiSamplePct: true } });
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        qaAiFormId: body.formId,
        qaAiSamplePct: body.samplePct,
        ...(body.forbiddenWords && { qaForbiddenWords: [...new Set(body.forbiddenWords.map((w) => w.toLowerCase()))] }),
        ...(body.alertThreshold !== undefined && { qaAlertThreshold: body.alertThreshold }),
      },
    });
    await fastify.audit({
      actorType: "TENANT_USER", actorId: request.tenantUser!.sub, tenantId, action: "tenant.qa.ai_settings",
      targetType: "Tenant", targetId: tenantId, before, after: body, ip: request.ip,
    });
    return { ok: true };
  });

  // POST /tenant/qa/ai/calls/:callId — audita já esta chamada (cria o rascunho)
  fastify.post<{ Params: { callId: string }; Body: { formId?: string } }>("/tenant/qa/ai/calls/:callId", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    if (!canEvaluate(user.role)) return reply.status(403).send({ error: "Só supervisão ou auditoria avalia" });
    try {
      const agentId = await agentOf(user.tenantId, { callId: request.params.callId });
      const scope = await userScope(user);
      if (agentId === user.sub) throw new QaError(403, "Não pode avaliar-se a si próprio");
      if (scope.kind !== "ALL" && (!agentId || !scope.userIds.includes(agentId))) throw new QaError(403, "Esse agente não é da sua equipa");
      const ev = await runAiAudit(fastify, user.tenantId, request.params.callId, request.body?.formId);
      await audit(request, "tenant.qa.ai_audited", ev.id);
      return reply.status(201).send(ev);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // POST /tenant/qa/evaluations/:id/submit — o auditor revê o rascunho da IA e submete
  fastify.post<{ Params: { id: string } }>("/tenant/qa/evaluations/:id/submit", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    if (!canEvaluate(user.role)) return reply.status(403).send({ error: "Só supervisão ou auditoria avalia" });
    const body = submitSchema.parse(request.body);
    const ev = await prisma.qaEvaluation.findFirst({ where: { id: request.params.id, tenantId: user.tenantId, ...evalScopeWhere(await userScope(user)) } });
    if (!ev) return reply.status(404).send({ error: "Avaliação não encontrada" });
    if (ev.status !== "AI_DRAFT") return reply.status(409).send({ error: "Esta avaliação já foi submetida" });
    if (ev.agentId === user.sub) return reply.status(403).send({ error: "Não pode avaliar-se a si próprio" });
    try {
      const def = ev.formSnapshot as unknown as FormDefinition;
      const answers = await applyAutoCriteria(user.tenantId, def, body.answers, ev.callId);
      const { score, criticalFail } = scoreEvaluation(def, answers);
      const res = await prisma.qaEvaluation.updateMany({
        where: { id: ev.id, status: "AI_DRAFT" }, // dois auditores ao mesmo tempo: só um submete
        data: { answers: cleanAnswers(def, answers), score, criticalFail, comment: body.comment ?? null, evaluatorId: user.sub, status: "SUBMITTED" },
      });
      if (res.count === 0) return reply.status(409).send({ error: "Esta avaliação já foi submetida" });
      // Antes/depois da IA fica no AuditLog: é daí que se mede a precisão da IA.
      await audit(request, "tenant.qa.ai_reviewed", ev.id, { answers: ev.answers, score: ev.score }, { answers, score, criticalFail });
      await checkQaStreak(user.tenantId, ev.agentId);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // DELETE /tenant/qa/evaluations/:id — descartar um rascunho da IA (a chamada volta à amostra)
  fastify.delete<{ Params: { id: string } }>("/tenant/qa/evaluations/:id", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    if (!canEvaluate(user.role)) return reply.status(403).send({ error: "Só supervisão ou auditoria avalia" });
    const ev = await prisma.qaEvaluation.findFirst({ where: { id: request.params.id, tenantId: user.tenantId, ...evalScopeWhere(await userScope(user)) } });
    if (!ev) return reply.status(404).send({ error: "Avaliação não encontrada" });
    if (ev.status !== "AI_DRAFT") return reply.status(409).send({ error: "Só se descartam rascunhos da IA" });
    await prisma.qaEvaluation.deleteMany({ where: { id: ev.id, status: "AI_DRAFT" } });
    await audit(request, "tenant.qa.ai_discarded", ev.id, { answers: ev.answers, score: ev.score });
    return { ok: true };
  });

  // O agente confirma que leu (com nota opcional) ou contesta (nota obrigatória)
  for (const action of ["acknowledge", "dispute"] as const) {
    fastify.post<{ Params: { id: string } }>(`/tenant/qa/evaluations/:id/${action}`, { preHandler }, async (request, reply) => {
      const user = request.tenantUser!;
      const { comment } = agentNoteSchema.parse(request.body ?? {});
      if (action === "dispute" && !comment) return reply.status(400).send({ error: "Explique o que contesta" });
      const ev = await prisma.qaEvaluation.findFirst({ where: { id: request.params.id, tenantId: user.tenantId, agentId: user.sub } });
      if (!ev) return reply.status(404).send({ error: "Avaliação não encontrada" });
      if (ev.status !== "SUBMITTED") return reply.status(409).send({ error: "Esta avaliação já foi confirmada ou contestada" });
      const updated = await prisma.qaEvaluation.update({
        where: { id: ev.id },
        data: { status: action === "dispute" ? "DISPUTED" : "ACKNOWLEDGED", acknowledgedAt: new Date(), agentComment: comment ?? null },
      });
      await audit(request, `tenant.qa.${action}d`, ev.id, undefined, { comment: comment ?? null });
      return updated;
    });
  }
};

/**
 * Alerta QA_LOW_STREAK: as últimas 3 avaliações submetidas do agente abaixo de
 * Tenant.qaAlertThreshold. Fecha quando a mais recente volta a estar acima.
 */
async function checkQaStreak(tenantId: string, agentId: string): Promise<void> {
  const { qaAlertThreshold: threshold } = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { qaAlertThreshold: true } });
  const openKey = `${tenantId}:QA_LOW_STREAK:${agentId}`;
  const last = await prisma.qaEvaluation.findMany({
    where: { tenantId, agentId, status: { not: "AI_DRAFT" } },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { score: true },
  });
  const low = threshold > 0 && last.length === 3 && last.every((e) => e.score < threshold);
  if (low) {
    const agent = await prisma.tenantUser.findUnique({
      where: { id: agentId },
      select: { extension: { select: { groups: { select: { groupId: true }, take: 1 } } } },
    });
    try {
      const alert = await prisma.alert.create({
        data: {
          tenantId,
          type: "QA_LOW_STREAK",
          ref: agentId,
          // Grupo da extensão do agente: assim só a supervisão dele o vê.
          groupId: agent?.extension?.groups[0]?.groupId ?? null,
          value: Math.round((last.reduce((n, e) => n + e.score, 0) / 3) * 10) / 10,
          threshold,
          openKey,
        },
      });
      emitWebhookAsync({ tenantId, event: "alert.opened", payload: { alertId: alert.id, type: alert.type, ref: alert.ref, groupId: alert.groupId, value: alert.value, threshold } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err; // já estava aberto
    }
  } else if (last[0]) {
    await prisma.alert.updateMany({ where: { openKey }, data: { endedAt: new Date(), endValue: last[0].score, openKey: null } });
  }
}
