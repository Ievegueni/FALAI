import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { buildAgentTimeReport } from "../../services/agentTime.service.js";
import { isOpsManager, userScope } from "../../services/userScope.js";
import type { TenantJwtPayload } from "../../plugins/auth.js";

/**
 * Agentes (fase 5): motivos de pausa, turnos e relatório de tempo — ver
 * services/agentTime.service.ts. Motivos: gestor/admin. Turnos: gestor/admin
 * e o supervisor para a sua equipa. Relatório: com o âmbito de quem pede.
 */

const reasonSchema = z.object({ label: z.string().trim().min(1).max(80), sortOrder: z.number().int().min(0).max(999).optional() });
const reasonUpdateSchema = reasonSchema.partial().extend({ isActive: z.boolean().optional() });

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora no formato HH:MM");
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const shiftsSchema = z
  .array(z.object({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm }))
  .max(21)
  .refine((list) => list.every((s) => toMin(s.end) > toMin(s.start)), "O fim do turno tem de ser depois do início (sem passar a meia-noite)");

const rangeSchema = z.object({ from: z.string().optional(), to: z.string().optional() });

const minToHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export const tenantAgentTimeRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // ── Motivos de pausa ──────────────────────────────────────────────────────
  fastify.get<{ Querystring: { all?: string } }>("/tenant/pause-reasons", { preHandler }, async (request) => {
    const data = await prisma.pauseReason.findMany({
      where: { tenantId: request.tenantUser!.tenantId, ...(request.query.all ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      select: { id: true, label: true, isActive: true, sortOrder: true },
    });
    return { data };
  });

  fastify.post("/tenant/pause-reasons", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = reasonSchema.parse(request.body);
    const row = await prisma.pauseReason.create({ data: { tenantId, label: body.label, ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }) } }).catch(() => null);
    if (!row) return reply.status(409).send({ error: "Já existe um motivo com esse nome" });
    return reply.status(201).send(row);
  });

  fastify.patch<{ Params: { id: string } }>("/tenant/pause-reasons/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = reasonUpdateSchema.parse(request.body);
    const data = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const res = await prisma.pauseReason.updateMany({ where: { id: request.params.id, tenantId }, data }).catch(() => null);
    if (!res) return reply.status(409).send({ error: "Já existe um motivo com esse nome" });
    if (res.count === 0) return reply.status(404).send({ error: "Motivo não encontrado" });
    return { ok: true };
  });

  // ── Turnos ────────────────────────────────────────────────────────────────
  /** Pode ver/alterar os turnos deste utilizador? Gestor/admin todos; supervisor a equipa; o próprio só ver. */
  async function canManageShifts(user: TenantJwtPayload, targetId: string) {
    if (isOpsManager(user.role)) return true;
    const scope = await userScope(user);
    return scope.kind === "TEAM" && scope.userIds.includes(targetId);
  }

  fastify.get<{ Params: { userId: string } }>("/tenant/team/:userId/shifts", { preHandler, config: { feature: "team" } }, async (request, reply) => {
    const user = request.tenantUser!;
    if (user.sub !== request.params.userId && !(await canManageShifts(user, request.params.userId)) && user.role !== "VIEWER") {
      return reply.status(403).send({ error: "Sem acesso aos turnos deste utilizador" });
    }
    const rows = await prisma.shift.findMany({
      where: { tenantId: user.tenantId, userId: request.params.userId },
      orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
    });
    return { data: rows.map((s) => ({ weekday: s.weekday, start: minToHhmm(s.startMin), end: minToHhmm(s.endMin) })) };
  });

  fastify.put<{ Params: { userId: string } }>("/tenant/team/:userId/shifts", { preHandler, config: { feature: "team" } }, async (request, reply) => {
    const user = request.tenantUser!;
    if (!(await canManageShifts(user, request.params.userId))) return reply.status(403).send({ error: "Sem permissão para alterar estes turnos" });
    const target = await prisma.tenantUser.findFirst({ where: { id: request.params.userId, tenantId: user.tenantId }, select: { id: true } });
    if (!target) return reply.status(404).send({ error: "Utilizador não encontrado" });
    const shifts = shiftsSchema.parse(request.body);
    await prisma.$transaction([
      prisma.shift.deleteMany({ where: { tenantId: user.tenantId, userId: target.id } }),
      prisma.shift.createMany({
        data: shifts.map((s) => ({ tenantId: user.tenantId, userId: target.id, weekday: s.weekday, startMin: toMin(s.start), endMin: toMin(s.end) })),
      }),
    ]);
    return { data: shifts };
  });

  // ── Relatório: escalado, ligado, aderência, pausas ────────────────────────
  fastify.get("/tenant/reports/agent-time", { preHandler, config: { feature: "reports" } }, async (request) => {
    const q = rangeSchema.parse(request.query);
    const to = q.to ? new Date(`${q.to}T23:59:59.999`) : new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(to.getTime() - 6 * 86_400_000);
    from.setHours(0, 0, 0, 0);
    return buildAgentTimeReport(request.tenantUser!.tenantId, await userScope(request.tenantUser!), from, to);
  });
};
