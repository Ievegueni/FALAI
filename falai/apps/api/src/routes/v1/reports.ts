import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { buildConsolidated } from "../../services/consolidated.service.js";

/**
 * Dados para Power BI / BI (fase 9) — ver docs/POWER-BI.md. Só leitura, scope
 * `reports:read`, uma linha por registo, datas em ISO 8601 e durações em
 * segundos. O Power BI liga-se pelo conector Web (cabeçalho Authorization).
 * Período por `from`/`to` (AAAA-MM-DD, por omissão os últimos 30 dias; até 366
 * dias) e paginação por `offset`/`limit` (até 50 000 linhas por pedido).
 */

const query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50_000).default(10_000),
  offset: z.coerce.number().int().min(0).default(0),
  bucket: z.enum(["day", "week", "month"]).default("day"),
});

function parse(request: FastifyRequest) {
  const q = query.parse(request.query);
  const to = q.to ? new Date(`${q.to}T23:59:59.999`) : new Date();
  const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(to.getTime() - 29 * 86_400_000);
  from.setHours(0, 0, 0, 0);
  if (to.getTime() - from.getTime() > 367 * 86_400_000) throw Object.assign(new Error("Período máximo: 366 dias"), { statusCode: 400 });
  return { ...q, from, to, range: { gte: from, lte: to }, page: { skip: q.offset, take: q.limit } };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const secs = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000)) : null);

export async function v1ReportsRoutes(fastify: FastifyInstance): Promise<void> {
  const pre = { preHandler: [fastify.verifyScope("reports:read")] };
  const tenantOf = (r: FastifyRequest) => r.apiKey!.tenantId;
  const groupNames = async (tenantId: string) =>
    new Map((await prisma.extensionGroup.findMany({ where: { tenantId }, select: { id: true, name: true } })).map((g) => [g.id, g.name]));

  // Painel consolidado (os mesmos números do CRM → Relatórios → Consolidado)
  fastify.get("/v1/reports/consolidated", pre, async (request) => {
    const q = parse(request);
    return buildConsolidated(tenantOf(request), q.from, q.to, q.bucket);
  });

  fastify.get("/v1/reports/calls", pre, async (request) => {
    const tenantId = tenantOf(request);
    const q = parse(request);
    const [rows, groups] = await Promise.all([
      prisma.call.findMany({
        where: { tenantId, createdAt: q.range },
        orderBy: { createdAt: "asc" },
        ...q.page,
        select: {
          id: true, createdAt: true, kind: true, status: true, fromNumber: true, toNumber: true, contactId: true, groupId: true, ticketId: true,
          queuedAt: true, answeredAt: true, endedAt: true, durationSecs: true, costCents: true, campaignId: true,
          contact: { select: { name: true } },
          legs: {
            where: { outcome: "ANSWERED" },
            take: 1,
            select: { extensionNumber: true, extension: { select: { displayName: true } }, category: { select: { name: true } }, subcategory: { select: { name: true } } },
          },
        },
      }),
      groupNames(tenantId),
    ]);
    return {
      data: rows.map((c) => {
        const leg = c.legs[0];
        return {
          id: c.id,
          createdAt: iso(c.createdAt),
          direction: c.kind === "INBOUND" ? "INBOUND" : "OUTBOUND",
          kind: c.kind,
          status: c.status,
          fromNumber: c.fromNumber,
          toNumber: c.toNumber,
          contactId: c.contactId,
          contactName: c.contact?.name ?? null,
          group: c.groupId ? (groups.get(c.groupId) ?? null) : null,
          agentExtension: leg?.extensionNumber ?? null,
          agentName: leg?.extension?.displayName ?? null,
          category: leg?.category?.name ?? null,
          subcategory: leg?.subcategory?.name ?? null,
          waitSecs: secs(c.queuedAt, c.answeredAt),
          talkSecs: secs(c.answeredAt, c.endedAt) ?? c.durationSecs,
          answered: !!c.answeredAt,
          costCents: c.costCents,
          campaignId: c.campaignId,
          ticketId: c.ticketId,
        };
      }),
    };
  });

  fastify.get("/v1/reports/conversations", pre, async (request) => {
    const q = parse(request);
    const rows = await prisma.conversation.findMany({
      where: { tenantId: tenantOf(request), createdAt: q.range },
      orderBy: { createdAt: "asc" },
      ...q.page,
      select: {
        id: true, createdAt: true, updatedAt: true, status: true, mode: true, contactId: true, messageCount: true, ticketId: true,
        inbox: { select: { name: true, channel: true } },
        assignee: { select: { name: true } },
        messages: { where: { role: { in: ["HUMAN", "AGENT"] } }, orderBy: { seq: "asc" }, take: 20, select: { role: true, createdAt: true } },
      },
    });
    return {
      data: rows.map((c) => {
        const human = c.messages.find((m) => m.role === "HUMAN")?.createdAt;
        const reply = c.messages.find((m) => m.role === "AGENT")?.createdAt;
        return {
          id: c.id,
          createdAt: iso(c.createdAt),
          channel: c.inbox.channel,
          inbox: c.inbox.name,
          status: c.status,
          mode: c.mode,
          assignee: c.assignee?.name ?? null,
          contactId: c.contactId,
          messages: c.messageCount,
          firstResponseSecs: human && reply && reply >= human ? secs(human, reply) : null,
          resolvedAt: c.status === "RESOLVED" ? iso(c.updatedAt) : null,
          ticketId: c.ticketId,
        };
      }),
    };
  });

  fastify.get("/v1/reports/tickets", pre, async (request) => {
    const q = parse(request);
    const rows = await prisma.ticket.findMany({
      where: { tenantId: tenantOf(request), createdAt: q.range },
      orderBy: { createdAt: "asc" },
      ...q.page,
      select: {
        id: true, number: true, createdAt: true, status: true, priority: true, supportLevel: true, source: true, contactId: true,
        resolvedAt: true, closedAt: true, reopenCount: true, dueAt: true, externalSystem: true, externalId: true,
        assignee: { select: { name: true } }, group: { select: { name: true } }, category: { select: { name: true } }, subcategory: { select: { name: true } },
      },
    });
    return {
      data: rows.map((t) => ({
        id: t.id,
        number: t.number,
        createdAt: iso(t.createdAt),
        status: t.status,
        priority: t.priority,
        supportLevel: t.supportLevel,
        source: t.source,
        assignee: t.assignee?.name ?? null,
        group: t.group?.name ?? null,
        category: t.category?.name ?? null,
        subcategory: t.subcategory?.name ?? null,
        contactId: t.contactId,
        dueAt: iso(t.dueAt),
        resolvedAt: iso(t.resolvedAt),
        closedAt: iso(t.closedAt),
        resolutionSecs: secs(t.createdAt, t.resolvedAt),
        reopenCount: t.reopenCount,
        externalSystem: t.externalSystem,
        externalId: t.externalId,
      })),
    };
  });

  fastify.get("/v1/reports/csat", pre, async (request) => {
    const tenantId = tenantOf(request);
    const q = parse(request);
    const [rows, groups] = await Promise.all([
      prisma.csatResponse.findMany({
        where: { tenantId, createdAt: q.range },
        orderBy: { createdAt: "asc" },
        ...q.page,
        select: { id: true, createdAt: true, answeredAt: true, channel: true, score: true, callId: true, conversationId: true, ticketId: true, contactId: true, groupId: true, agent: { select: { name: true } } },
      }),
      groupNames(tenantId),
    ]);
    return {
      data: rows.map(({ agent, groupId, createdAt, answeredAt, ...r }) => ({
        ...r,
        createdAt: iso(createdAt),
        answeredAt: iso(answeredAt),
        agent: agent?.name ?? null,
        group: groupId ? (groups.get(groupId) ?? null) : null,
      })),
    };
  });

  fastify.get("/v1/reports/qa", pre, async (request) => {
    const q = parse(request);
    const rows = await prisma.qaEvaluation.findMany({
      where: { tenantId: tenantOf(request), createdAt: q.range },
      orderBy: { createdAt: "asc" },
      ...q.page,
      select: {
        id: true, createdAt: true, score: true, criticalFail: true, status: true, callId: true, conversationId: true, ticketId: true,
        agent: { select: { name: true } }, evaluator: { select: { name: true } }, form: { select: { name: true } },
      },
    });
    return {
      data: rows.map(({ agent, evaluator, form, createdAt, ...r }) => ({
        ...r,
        createdAt: iso(createdAt),
        agent: agent.name,
        evaluator: evaluator.name,
        form: form?.name ?? null,
      })),
    };
  });
}
