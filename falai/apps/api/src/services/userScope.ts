import { prisma, type Prisma } from "@falai/db";

/**
 * Papéis e âmbito do que cada utilizador do CRM vê (centro de atendimento,
 * fase 2 — ver docs/PLANO-CENTRO-ATENDIMENTO.md).
 *
 *   OWNER / ADMIN  administrador: tudo, incluindo configuração técnica
 *   MANAGER        gestor operacional: toda a operação (relatórios, equipa,
 *                  supervisão, tipificações), sem configuração técnica
 *   SUPERVISOR     a sua equipa: os grupos que supervisiona e os agentes deles
 *   MEMBER         agente: só o que é seu (atribuído a si, ou por atribuir na fila dele)
 *   VIEWER         consulta de tudo, sem alterar nada
 */

export const CONFIG_ROLES = new Set(["OWNER", "ADMIN"]);
export const OPS_ROLES = new Set(["OWNER", "ADMIN", "MANAGER"]);

/** Configuração técnica: telefonia, canais, API/webhooks, definições da conta. */
export const isConfigAdmin = (role: string) => CONFIG_ROLES.has(role);
/** Gestão da operação: equipa, supervisão, tipificações, análise de relatórios. */
export const isOpsManager = (role: string) => OPS_ROLES.has(role);

export type UserScope =
  | { kind: "ALL" }
  | {
      kind: "TEAM" | "SELF";
      userId: string;
      /** TEAM: grupos supervisionados. SELF: grupos onde a extensão do agente atende. */
      groupIds: string[];
      extensionIds: string[];
      extensionNumbers: string[];
      /** Utilizadores cujas extensões estão no âmbito (inclui o próprio). */
      userIds: string[];
    };

export async function userScope(user: { sub: string; tenantId: string; role: string }): Promise<UserScope> {
  if (isOpsManager(user.role) || user.role === "VIEWER") return { kind: "ALL" };

  let groupIds: string[];
  let extensionIds: string[];
  if (user.role === "SUPERVISOR") {
    groupIds = (await prisma.supervisorGroup.findMany({ where: { tenantUserId: user.sub, group: { tenantId: user.tenantId } }, select: { groupId: true } })).map((g) => g.groupId);
    extensionIds = (await prisma.extensionGroupMember.findMany({ where: { groupId: { in: groupIds } }, select: { extensionId: true } })).map((m) => m.extensionId);
  } else {
    const me = await prisma.tenantUser.findUnique({
      where: { id: user.sub },
      select: { extensionId: true, extension: { select: { groups: { select: { groupId: true } } } } },
    });
    extensionIds = me?.extensionId ? [me.extensionId] : [];
    groupIds = me?.extension?.groups.map((g) => g.groupId) ?? [];
  }
  const [extensions, users] = await Promise.all([
    prisma.extension.findMany({ where: { id: { in: extensionIds }, tenantId: user.tenantId }, select: { number: true } }),
    prisma.tenantUser.findMany({ where: { tenantId: user.tenantId, extensionId: { in: extensionIds } }, select: { id: true } }),
  ]);
  return {
    kind: user.role === "SUPERVISOR" ? "TEAM" : "SELF",
    userId: user.sub,
    groupIds,
    extensionIds,
    extensionNumbers: extensions.map((e) => e.number),
    userIds: [...new Set([user.sub, ...users.map((u) => u.id)])],
  };
}

// ─── Tickets ──────────────────────────────────────────────────────────────────

/**
 * Tickets visíveis. Agente: atribuídos a si, criados por si, ou por atribuir
 * na fila dele (grupo dele ou sem grupo). Supervisor: os dos seus grupos, os
 * da sua equipa, os seus e os que ainda não têm dono nem grupo.
 */
export function ticketScopeWhere(scope: UserScope): Prisma.TicketWhereInput {
  if (scope.kind === "ALL") return {};
  const unrouted: Prisma.TicketWhereInput = { assigneeId: null, groupId: null };
  if (scope.kind === "SELF") {
    return {
      OR: [
        { assigneeId: scope.userId },
        { createdById: scope.userId },
        unrouted,
        ...(scope.groupIds.length ? [{ assigneeId: null, groupId: { in: scope.groupIds } }] : []),
      ],
    };
  }
  return {
    OR: [
      { groupId: { in: scope.groupIds } },
      { assigneeId: { in: scope.userIds } },
      { createdById: scope.userId },
      unrouted,
    ],
  };
}

type TicketAccess = { assigneeId: string | null; groupId: string | null; createdById: string | null };

/** Pode alterar o ticket? O agente só os que estão atribuídos a si. */
export function canEditTicket(scope: UserScope, t: TicketAccess): boolean {
  if (scope.kind === "ALL") return true;
  if (scope.kind === "SELF") return t.assigneeId === scope.userId;
  return (
    (t.groupId !== null && scope.groupIds.includes(t.groupId)) ||
    (t.assigneeId !== null && scope.userIds.includes(t.assigneeId)) ||
    t.createdById === scope.userId ||
    (t.assigneeId === null && t.groupId === null)
  );
}

/**
 * O agente pode "pegar" num ticket por atribuir que vê (atribuir-se a si) e,
 * num ticket seu, só o pode devolver à fila — nunca passá-lo a um colega.
 */
export function agentAssignmentAllowed(scope: UserScope, t: TicketAccess, nextAssigneeId: string | null | undefined): boolean {
  if (scope.kind !== "SELF" || nextAssigneeId === undefined) return true;
  if (t.assigneeId === null) return nextAssigneeId === scope.userId;
  return t.assigneeId === scope.userId && (nextAssigneeId === null || nextAssigneeId === scope.userId);
}

// ─── Conversas ────────────────────────────────────────────────────────────────

/** Conversas: o agente vê as suas e as por atribuir (a fila). Sem grupos nas conversas. */
export function conversationScopeWhere(scope: UserScope): Prisma.ConversationWhereInput {
  if (scope.kind !== "SELF") return {};
  return { OR: [{ assigneeId: scope.userId }, { assigneeId: null }] };
}

// ─── Chamadas ─────────────────────────────────────────────────────────────────

/**
 * Chamadas: as que tocaram nas extensões do âmbito, as do grupo (supervisor) e
 * as directas feitas dessas extensões (o webphone guarda o número da extensão
 * em fromNumber). Chamadas de IA/campanhas não são de nenhum agente.
 */
export function callScopeWhere(scope: UserScope): Prisma.CallWhereInput {
  if (scope.kind === "ALL") return {};
  return {
    OR: [
      { legs: { some: { extensionId: { in: scope.extensionIds } } } },
      { kind: "DIRECT", fromNumber: { in: scope.extensionNumbers } },
      ...(scope.kind === "TEAM" ? [{ groupId: { in: scope.groupIds } }] : []),
    ],
  };
}

/** CDR do PBX do cliente (BYO): só pelo número da extensão. */
export function pbxCallScopeWhere(scope: UserScope): Prisma.PbxCallWhereInput {
  if (scope.kind === "ALL") return {};
  return { OR: [{ fromNumber: { in: scope.extensionNumbers } }, { toNumber: { in: scope.extensionNumbers } }] };
}

// ─── preHandlers ──────────────────────────────────────────────────────────────

type Req = { tenantUser?: { role: string } | undefined };
type Rep = { status: (code: number) => { send: (body: unknown) => unknown } };

/** Depois de verifyTenant: só OWNER/ADMIN (configuração técnica). */
export async function requireConfigAdmin(request: Req, reply: Rep) {
  if (!request.tenantUser || !isConfigAdmin(request.tenantUser.role)) {
    return reply.status(403).send({ error: "Só administradores podem alterar a configuração técnica" });
  }
  return undefined;
}

/** Depois de verifyTenant: só OWNER/ADMIN/MANAGER (acções que gastam saldo, ex.: enviar SMS). */
export async function requireOpsManager(request: Req, reply: Rep) {
  if (!request.tenantUser || !isOpsManager(request.tenantUser.role)) {
    return reply.status(403).send({ error: "Apenas administradores ou gestores" });
  }
  return undefined;
}
