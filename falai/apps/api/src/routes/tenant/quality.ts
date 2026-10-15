import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@falai/db";
import {
  ANSWERS,
  QaError,
  agentOf,
  cleanAnswers,
  normalizeDefinition,
  qaSample,
  scoreEvaluation,
  type FormDefinition,
} from "../../services/quality.service.js";
import { isOpsManager, userScope, type UserScope } from "../../services/userScope.js";

/**
 * Qualidade (fase 7) — ver services/quality.service.ts.
 *   Formulários: gestor/admin.
 *   Avaliar: gestor/admin todos; supervisor os agentes da equipa; ninguém a si.
 *   Ver: agente as suas; supervisor as da equipa; gestor/admin/consulta todas.
 *   Agente: confirma a leitura ou contesta. Avaliador/gestor revê (fica no AuditLog).
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
const agentNoteSchema = z.object({ comment: z.string().trim().max(5000).optional() });
const listQuery = z.object({
  agentId: z.string().optional(),
  status: z.enum(["SUBMITTED", "ACKNOWLEDGED", "DISPUTED", "RESOLVED"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

/** Avaliações visíveis por âmbito. */
function evalScopeWhere(scope: UserScope): Prisma.QaEvaluationWhereInput {
  if (scope.kind === "ALL") return {};
  if (scope.kind === "SELF") return { agentId: scope.userId };
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
  const canEvaluate = (role: string) => isOpsManager(role) || role === "SUPERVISOR";
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
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = formSchema.parse(request.body);
    const row = await prisma.qaForm
      .create({ data: { tenantId, name: body.name, definition: normalizeDefinition(body.definition) } })
      .catch(() => null);
    if (!row) return reply.status(409).send({ error: "Já existe um formulário com esse nome" });
    return reply.status(201).send(row);
  });

  fastify.put<{ Params: { id: string } }>("/tenant/qa/forms/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
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
      ...evalScopeWhere(await userScope(request.tenantUser!)),
      ...(q.agentId && { agentId: q.agentId }),
      ...(q.status && { status: q.status }),
      ...(created && { createdAt: created }),
    };
    const [data, total] = await Promise.all([
      prisma.qaEvaluation.findMany({
        where,
        orderBy: { createdAt: "desc" },
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
    const where: Prisma.QaEvaluationWhereInput = { tenantId, ...evalScopeWhere(await userScope(request.tenantUser!)), ...(created && { createdAt: created }) };
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
      canEdit: ev.evaluatorId === user.sub || isOpsManager(user.role),
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
      const { score, criticalFail } = scoreEvaluation(def, body.answers);
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
          answers: cleanAnswers(def, body.answers),
          score,
          criticalFail,
          comment: body.comment ?? null,
        },
      });
      await audit(request, "tenant.qa.evaluated", ev.id, undefined, { score, criticalFail, agentId });
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
    if (ev.evaluatorId !== user.sub && !isOpsManager(user.role)) return reply.status(403).send({ error: "Só quem avaliou ou um gestor a pode rever" });
    try {
      const def = ev.formSnapshot as unknown as FormDefinition;
      const scored = body.answers ? scoreEvaluation(def, body.answers) : null;
      const data: Prisma.QaEvaluationUpdateInput = {
        ...(body.answers && { answers: cleanAnswers(def, body.answers), score: scored!.score, criticalFail: scored!.criticalFail }),
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
      return updated;
    } catch (err) {
      return fail(reply, err);
    }
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
