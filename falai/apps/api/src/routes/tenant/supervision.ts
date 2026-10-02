import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { extensionEndpointId, extensionWebEndpointId } from "@falai/providers";
import type { TenantJwtPayload } from "../../plugins/auth.js";
import { activeInboundCalls, monitoringNoticePrompt } from "../../services/inboundCallRouter.service.js";
import { SupervisionError } from "../../services/supervision.service.js";
import { callKpis, abandonedIds } from "../../services/attendanceReport.service.js";
import { isTelephonyWav } from "../shared/ivrRouting.js";

/**
 * Supervisão em tempo real (melhoria 4/4) — ver services/supervision.service.ts.
 *
 * Permissões: OWNER/ADMIN supervisionam tudo; SUPERVISOR só os grupos que lhe
 * foram atribuídos (Equipa) e as extensões desses grupos. O painel actualiza-se
 * por polling (GET /live): cada pedido aplica as permissões de quem pede.
 */

type Scope = { all: true } | { all: false; groupIds: Set<string>; extensionIds: Set<string> };

export async function supervisionScope(user: TenantJwtPayload): Promise<Scope | null> {
  if (user.role === "OWNER" || user.role === "ADMIN") return { all: true };
  if (user.role !== "SUPERVISOR") return null;
  const groups = await prisma.supervisorGroup.findMany({ where: { tenantUserId: user.sub }, select: { groupId: true } });
  const groupIds = new Set(groups.map((g) => g.groupId));
  const members = await prisma.extensionGroupMember.findMany({
    where: { groupId: { in: [...groupIds] }, group: { tenantId: user.tenantId } },
    select: { extensionId: true },
  });
  return { all: false, groupIds, extensionIds: new Set(members.map((m) => m.extensionId)) };
}

/** Uma chamada está no âmbito se o grupo dela ou o agente que a atendeu estão. */
export function inScope(scope: Scope, call: { groupId: string | null; agentExtensionId: string }): boolean {
  return scope.all || (call.groupId !== null && scope.groupIds.has(call.groupId)) || scope.extensionIds.has(call.agentExtensionId);
}

export type AgentState = "IN_CALL" | "RINGING" | "WRAP_UP" | "PAUSED" | "AVAILABLE" | "OFFLINE";

/** Estado do agente, do mais forte para o mais fraco. */
export function agentState(a: {
  inCallSince: Date | null;
  ringingSince: Date | null;
  wrapUpSince: Date | null;
  pausedAt: Date | null;
  online: boolean;
}): { state: AgentState; since: Date | null } {
  if (a.inCallSince) return { state: "IN_CALL", since: a.inCallSince };
  if (a.ringingSince) return { state: "RINGING", since: a.ringingSince };
  if (a.wrapUpSince) return { state: "WRAP_UP", since: a.wrapUpSince };
  if (a.pausedAt) return { state: "PAUSED", since: a.pausedAt };
  return { state: a.online ? "AVAILABLE" : "OFFLINE", since: null };
}

const modeSchema = z.object({ mode: z.enum(["LISTEN", "WHISPER", "BARGE"]) });
const settingsSchema = z.object({
  supervisionNotifyListen: z.boolean().optional(),
  monitoringNotice: z.boolean().optional(),
});
const logSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});
const pauseSchema = z.object({ extensionId: z.string(), paused: z.boolean() });

// Estado de registo das extensões no Asterisk, com cache curta: o painel pede-o
// de 2 em 2 s por cada supervisor.
const onlineCache = new Map<string, { online: boolean; at: number }>();
const ONLINE_TTL_MS = 5_000;

export const tenantSupervisionRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  async function scopeOr403(user: TenantJwtPayload, reply: FastifyReply): Promise<Scope | null> {
    const scope = await supervisionScope(user);
    if (!scope) reply.status(403).send({ error: "Só supervisores ou administradores" });
    return scope;
  }

  async function isOnline(sipAuthUser: string): Promise<boolean> {
    const hit = onlineCache.get(sipAuthUser);
    if (hit && Date.now() - hit.at < ONLINE_TTL_MS) return hit.online;
    const states = await Promise.all(
      [extensionEndpointId(sipAuthUser), extensionWebEndpointId(sipAuthUser)].map((e) => fastify.asterisk.endpointState(e))
    );
    const online = states.includes("online");
    onlineCache.set(sipAuthUser, { online, at: Date.now() });
    return online;
  }

  // GET /tenant/supervision/live — agentes, chamadas activas e indicadores do dia
  fastify.get("/tenant/supervision/live", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    const scope = await scopeOr403(user, reply);
    if (!scope) return;
    const { tenantId } = user;
    const now = new Date();

    const extensions = await prisma.extension.findMany({
      where: { tenantId, isActive: true, ...(!scope.all && { id: { in: [...scope.extensionIds] } }) },
      orderBy: { number: "asc" },
      select: { id: true, number: true, displayName: true, sipAuthUser: true, pausedAt: true },
    });
    const extIds = extensions.map((e) => e.id);
    const calls = activeInboundCalls(tenantId).filter((c) => inScope(scope, c));

    const [ringing, wrapUps, callRows, groups, todayCalls, todayLegs, online, me] = await Promise.all([
      prisma.callLeg.findMany({
        where: { tenantId, extensionId: { in: extIds }, outcome: null, ringStartedAt: { gte: new Date(now.getTime() - 5 * 60_000) } },
        select: { extensionId: true, ringStartedAt: true },
      }),
      prisma.callLeg.findMany({
        where: { tenantId, extensionId: { in: extIds }, typedAt: null, wrapUpEndsAt: { gt: now } },
        select: { extensionId: true, endedAt: true },
      }),
      prisma.call.findMany({
        where: { tenantId, id: { in: calls.map((c) => c.callId) } },
        select: { id: true, fromNumber: true, contact: { select: { name: true } } },
      }),
      prisma.extensionGroup.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      prisma.call.findMany({
        where: {
          tenantId,
          kind: "INBOUND",
          queuedAt: { gte: startOfDay(now) },
          ...(!scope.all && { groupId: { in: [...scope.groupIds] } }),
        },
        select: { id: true, queuedAt: true, answeredAt: true, endedAt: true, groupId: true },
      }),
      prisma.callLeg.findMany({
        where: { tenantId, ringStartedAt: { gte: startOfDay(now) }, outcome: "CANCELLED" },
        select: { callId: true, outcome: true },
      }),
      Promise.all(extensions.map((e) => isOnline(e.sipAuthUser))),
      prisma.tenantUser.findUnique({ where: { id: user.sub }, select: { extensionId: true } }),
    ]);

    const byExt = <T extends { extensionId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.extensionId!, r]));
    const ringingBy = byExt(ringing);
    const wrapBy = byExt(wrapUps);
    const callBy = new Map(calls.map((c) => [c.agentExtensionId, c]));
    const rowBy = new Map(callRows.map((r) => [r.id, r]));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const extBy = new Map(extensions.map((e) => [e.id, e]));
    const k = callKpis(todayCalls, abandonedIds(todayLegs));

    return {
      now,
      agents: extensions.map((e, i) => ({
        extensionId: e.id,
        number: e.number,
        name: e.displayName,
        ...agentState({
          inCallSince: callBy.get(e.id)?.answeredAt ?? null,
          ringingSince: ringingBy.get(e.id)?.ringStartedAt ?? null,
          wrapUpSince: wrapBy.get(e.id)?.endedAt ?? null,
          pausedAt: e.pausedAt,
          online: online[i]!,
        }),
      })),
      calls: calls.map((c) => {
        const row = rowBy.get(c.callId);
        const ext = extBy.get(c.agentExtensionId);
        const session = fastify.supervision.forCall(c.callId);
        return {
          callId: c.callId,
          agent: ext ? (ext.displayName ?? ext.number) : null,
          agentNumber: ext?.number ?? null,
          group: c.groupId ? (groupName.get(c.groupId) ?? null) : null,
          customer: row?.contact?.name ?? null,
          number: row?.fromNumber ?? null,
          since: c.answeredAt,
          supervision: session
            ? { sessionId: session.id, mode: session.mode, status: session.status, mine: session.supervisorId === user.sub }
            : null,
          // a própria chamada do supervisor não se pode supervisionar
          ownCall: me?.extensionId === c.agentExtensionId,
        };
      }),
      kpis: {
        queued: todayCalls.filter((c) => c.queuedAt && !c.answeredAt && !c.endedAt).length,
        tmeSecs: k.tmeSecs,
        missed: k.missed,
        answered: k.answered,
      },
    };
  });

  // POST /tenant/supervision/calls/:callId — começa (body: { mode })
  fastify.post<{ Params: { callId: string } }>("/tenant/supervision/calls/:callId", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    const scope = await scopeOr403(user, reply);
    if (!scope) return;
    const { mode } = modeSchema.parse(request.body);
    const call = activeInboundCalls(user.tenantId).find((c) => c.callId === request.params.callId);
    if (!call) return reply.status(404).send({ error: "A chamada já não está activa" });
    if (!inScope(scope, call)) return reply.status(403).send({ error: "Esta chamada não é de um grupo que supervisione" });

    const me = await prisma.tenantUser.findUnique({
      where: { id: user.sub },
      select: { extension: { select: { id: true, sipAuthUser: true, isActive: true } } },
    });
    if (!me?.extension?.isActive) {
      return reply.status(409).send({ error: "Associe-lhe uma extensão em Equipa para ouvir as chamadas" });
    }
    try {
      const s = await fastify.supervision.start({
        call,
        supervisorId: user.sub,
        supervisorExtensionId: me.extension.id,
        supervisorEndpoints: [extensionWebEndpointId(me.extension.sipAuthUser), extensionEndpointId(me.extension.sipAuthUser)],
        mode,
      });
      return reply.status(201).send({ sessionId: s.id, status: s.status, mode: s.mode });
    } catch (err) {
      if (err instanceof SupervisionError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }
  });

  // PATCH /tenant/supervision/sessions/:id — troca de modo (só quem supervisiona)
  fastify.patch<{ Params: { id: string } }>("/tenant/supervision/sessions/:id", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    const { mode } = modeSchema.parse(request.body);
    const s = fastify.supervision.get(request.params.id);
    if (!s || s.tenantId !== user.tenantId) return reply.status(404).send({ error: "Supervisão não encontrada" });
    if (s.supervisorId !== user.sub) return reply.status(403).send({ error: "Esta supervisão é de outro supervisor" });
    try {
      const updated = await fastify.supervision.setMode(s.id, mode);
      return { sessionId: updated.id, status: updated.status, mode: updated.mode };
    } catch (err) {
      if (err instanceof SupervisionError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }
  });

  // DELETE /tenant/supervision/sessions/:id — termina (a chamada continua)
  fastify.delete<{ Params: { id: string } }>("/tenant/supervision/sessions/:id", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    const s = fastify.supervision.get(request.params.id);
    if (!s || s.tenantId !== user.tenantId) return reply.status(404).send({ error: "Supervisão não encontrada" });
    // Quem supervisiona termina; um admin também pode (ex.: sessão esquecida).
    if (s.supervisorId !== user.sub && user.role !== "OWNER" && user.role !== "ADMIN") {
      return reply.status(403).send({ error: "Esta supervisão é de outro supervisor" });
    }
    await fastify.supervision.end(s.id, "SUPERVISOR");
    return reply.status(204).send();
  });

  // GET /tenant/supervision/log — registo (OWNER/ADMIN), uma linha por supervisão
  fastify.get("/tenant/supervision/log", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    if (user.role !== "OWNER" && user.role !== "ADMIN") return reply.status(403).send({ error: "Apenas OWNER ou ADMIN" });
    const q = logSchema.parse(request.query);
    const PAGE = 25;
    const range = {
      ...(q.from && { gte: new Date(`${q.from}T00:00:00`) }),
      ...(q.to && { lte: new Date(`${q.to}T23:59:59.999`) }),
    };
    const where = { tenantId: user.tenantId, type: "START" as const, ...(Object.keys(range).length && { at: range }) };
    const [total, starts] = await Promise.all([
      prisma.supervisionEvent.count({ where }),
      prisma.supervisionEvent.findMany({ where, orderBy: { at: "desc" }, skip: (q.page - 1) * PAGE, take: PAGE }),
    ]);
    const sessionIds = starts.map((s) => s.sessionId);
    const [events, users, contacts] = await Promise.all([
      prisma.supervisionEvent.findMany({ where: { tenantId: user.tenantId, sessionId: { in: sessionIds } }, orderBy: { at: "asc" } }),
      prisma.tenantUser.findMany({ where: { id: { in: [...new Set(starts.map((s) => s.supervisorId))] } }, select: { id: true, name: true } }),
      prisma.contact.findMany({
        where: { tenantId: user.tenantId, id: { in: starts.map((s) => s.contactId).filter((x): x is string => !!x) } },
        select: { id: true, name: true, phone: true },
      }),
    ]);
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const contactBy = new Map(contacts.map((c) => [c.id, c]));
    return {
      total,
      page: q.page,
      pageSize: PAGE,
      data: starts.map((s) => {
        const evs = events.filter((e) => e.sessionId === s.sessionId);
        const end = evs.find((e) => e.type === "END");
        const contact = s.contactId ? contactBy.get(s.contactId) : undefined;
        return {
          sessionId: s.sessionId,
          supervisor: userName.get(s.supervisorId) ?? s.supervisorId,
          agent: s.agentExtension,
          callId: s.callId,
          customer: contact ? (contact.name ?? contact.phone) : null,
          startedAt: s.at,
          endedAt: end?.at ?? null,
          endReason: end?.endReason ?? null,
          modes: evs.filter((e) => e.type !== "END").map((e) => ({ mode: e.mode, at: e.at })),
        };
      }),
    };
  });

  // ── Definições (OWNER/ADMIN) ───────────────────────────────────────────────

  fastify.get("/tenant/supervision/settings", { preHandler }, async (request) => {
    return prisma.tenant.findUniqueOrThrow({
      where: { id: request.tenantUser!.tenantId },
      select: { supervisionNotifyListen: true, monitoringNotice: true },
    });
  });

  fastify.patch("/tenant/supervision/settings", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (role !== "OWNER" && role !== "ADMIN") return reply.status(403).send({ error: "Apenas OWNER ou ADMIN" });
    const body = settingsSchema.parse(request.body);
    return prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(body.supervisionNotifyListen !== undefined && { supervisionNotifyListen: body.supervisionNotifyListen }),
        ...(body.monitoringNotice !== undefined && { monitoringNotice: body.monitoringNotice }),
      },
      select: { supervisionNotifyListen: true, monitoringNotice: true },
    });
  });

  // POST /tenant/supervision/notice-audio — áudio do aviso ao cliente (Lei 22/11)
  fastify.post("/tenant/supervision/notice-audio", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (role !== "OWNER" && role !== "ADMIN") return reply.status(403).send({ error: "Apenas OWNER ou ADMIN" });
    const file = request.isMultipart() ? await request.file() : undefined;
    if (!file) return reply.status(400).send({ error: "Envie o áudio num campo 'file' (multipart)" });
    const wav = await file.toBuffer();
    if (!isTelephonyWav(wav)) return reply.status(400).send({ error: "Áudio tem de ser WAV PCM 16-bit, 8 kHz, mono" });
    await fastify.asterisk.uploadPrompt(monitoringNoticePrompt(tenantId), wav);
    await prisma.tenant.update({ where: { id: tenantId }, data: { monitoringNotice: true } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, tenantId, action: "tenant.monitoring_notice.uploaded", targetType: "Tenant", targetId: tenantId, ip: request.ip });
    return { ok: true };
  });

  // ── Pausa do agente ─────────────────────────────────────────────────────────

  // POST /tenant/supervision/pause — o agente pausa a extensão que usa no webphone
  fastify.post("/tenant/supervision/pause", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = pauseSchema.parse(request.body);
    const res = await prisma.extension.updateMany({
      where: { id: body.extensionId, tenantId },
      data: { pausedAt: body.paused ? new Date() : null },
    });
    if (res.count === 0) return reply.status(404).send({ error: "Extensão não encontrada" });
    return { paused: body.paused };
  });

  fastify.get<{ Querystring: { extensionId?: string } }>("/tenant/supervision/pause", { preHandler }, async (request, reply) => {
    const ext = request.query.extensionId
      ? await prisma.extension.findFirst({ where: { id: request.query.extensionId, tenantId: request.tenantUser!.tenantId }, select: { pausedAt: true } })
      : null;
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });
    return { paused: ext.pausedAt !== null, since: ext.pausedAt };
  });
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
