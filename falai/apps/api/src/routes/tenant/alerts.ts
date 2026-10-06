import type { FastifyPluginAsync } from "fastify";
import { prisma, type Prisma } from "@falai/db";
import { z } from "zod";
import { parseTargets, targetsSchema } from "../../services/alerts.service.js";
import { isOpsManager, userScope } from "../../services/userScope.js";

/**
 * Metas e alertas operacionais (fase 4) — ver services/alerts.service.ts.
 * Metas: consulta para supervisão, alteração para gestor/admin. Alertas:
 * supervisor vê os dos seus grupos (e os da conta, sem grupo); agente não vê.
 */

const ALERT_TYPES = ["LONG_WAIT", "LONG_HANDLE", "NO_AGENTS", "SLA_BELOW", "ABANDON_ABOVE", "TMA_ABOVE"] as const;

const listQuery = z.object({
  open: z.enum(["true", "false"]).optional(),
  type: z.enum(ALERT_TYPES).optional(),
  from: z.string().optional(), // AAAA-MM-DD
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
});

export const tenantAlertsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  fastify.get("/tenant/alerts/settings", { preHandler }, async (request) => {
    const t = await prisma.tenant.findUnique({ where: { id: request.tenantUser!.tenantId }, select: { serviceTargets: true } });
    return parseTargets(t?.serviceTargets);
  });

  fastify.put("/tenant/alerts/settings", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const targets = targetsSchema.parse(request.body);
    // Grava-se sempre um objecto (mesmo tudo desligado): assim o avaliador
    // continua a passar por este cliente e fecha os alertas que ficaram abertos.
    await prisma.tenant.update({ where: { id: tenantId }, data: { serviceTargets: targets } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.alerts.targets_updated", targetType: "Tenant", targetId: tenantId, ip: request.ip });
    return targets;
  });

  // GET /tenant/alerts — abertos (?open=true) ou histórico do período (relatório de desvios)
  fastify.get("/tenant/alerts", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const scope = await userScope(request.tenantUser!);
    if (scope.kind === "SELF") return reply.status(403).send({ error: "Os alertas são para supervisão" });
    const q = listQuery.parse(request.query);
    const day = (s: string, end: boolean) => {
      const d = new Date(`${s}T00:00:00`);
      if (end) d.setHours(23, 59, 59, 999);
      return d;
    };
    const where: Prisma.AlertWhereInput = {
      tenantId,
      ...(q.open === "true" && { endedAt: null }),
      ...(q.open === "false" && { endedAt: { not: null } }),
      ...(q.type && { type: q.type }),
      ...((q.from || q.to) && { startedAt: { ...(q.from && { gte: day(q.from, false) }), ...(q.to && { lte: day(q.to, true) }) } }),
      ...(scope.kind === "TEAM" && { OR: [{ groupId: null }, { groupId: { in: scope.groupIds } }] }),
    };
    const [rows, total, byType, groups] = await Promise.all([
      prisma.alert.findMany({ where, orderBy: { startedAt: "desc" }, skip: (q.page - 1) * q.perPage, take: q.perPage }),
      prisma.alert.count({ where }),
      prisma.alert.groupBy({ by: ["type"], where, _count: { _all: true } }),
      prisma.extensionGroup.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    return {
      data: rows.map(({ openKey: _k, ...a }) => ({ ...a, group: a.groupId ? (groupName.get(a.groupId) ?? null) : null })),
      total,
      page: q.page,
      perPage: q.perPage,
      byType: Object.fromEntries(byType.map((b) => [b.type, b._count._all])),
    };
  });
};
