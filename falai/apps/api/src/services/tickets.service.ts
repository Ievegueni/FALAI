import { prisma, type Prisma, type TicketEventType, type TicketPriority, type TicketStatus } from "@falai/db";

/**
 * Tickets (centro de atendimento, fase 1) — ver docs/PLANO-CENTRO-ATENDIMENTO.md.
 *
 * Regras de estado:
 *   - CLOSED é final: nada muda num ticket fechado.
 *   - Sair de RESOLVED para OPEN/PENDING/ON_HOLD é reabrir: conta em
 *     reopenCount e limpa resolvedAt.
 *   - resolvedAt/closedAt marcam-se na transição.
 *
 * Cada alteração gera um TicketEvent (from → to); é a linha do tempo do caso
 * e a auditoria de quem mudou o quê.
 */

export const TICKET_STATUSES = ["OPEN", "PENDING", "ON_HOLD", "RESOLVED", "CLOSED"] as const;
export const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export class TicketError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface TicketState {
  status: TicketStatus;
  priority: TicketPriority;
  supportLevel: number;
  assigneeId: string | null;
  groupId: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  subject: string;
  description: string | null;
  dueAt: Date | null;
}

export type TicketPatch = { [K in keyof TicketState]?: TicketState[K] | undefined };

interface EventDraft {
  type: TicketEventType;
  fromValue: string | null;
  toValue: string | null;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * Calcula o update e os eventos de uma alteração. Pura — sem BD — para se
 * poder testar as regras de estado à parte.
 */
export function planTicketUpdate(
  before: TicketState & { reopenCount: number },
  patch: TicketPatch,
  now = new Date()
): { data: Prisma.TicketUncheckedUpdateInput; events: EventDraft[]; reopened: boolean } {
  if (before.status === "CLOSED") throw new TicketError(409, "O ticket está fechado e não pode ser alterado");

  const data: Prisma.TicketUncheckedUpdateInput = {};
  const events: EventDraft[] = [];
  let reopened = false;

  const track = <K extends keyof TicketState>(key: K, type: TicketEventType | null) => {
    if (patch[key] === undefined) return;
    const next = patch[key] as TicketState[K];
    if (str(next) === str(before[key])) return;
    (data as Record<string, unknown>)[key] = next;
    if (type) events.push({ type, fromValue: str(before[key]), toValue: str(next) });
  };

  if (patch.status && patch.status !== before.status) {
    const next = patch.status;
    data.status = next;
    events.push({ type: "STATUS", fromValue: before.status, toValue: next });
    if (next === "RESOLVED") data.resolvedAt = now;
    if (next === "CLOSED") {
      data.closedAt = now;
      if (before.status !== "RESOLVED") data.resolvedAt = now;
    }
    if (before.status === "RESOLVED" && next !== "CLOSED") {
      reopened = true;
      data.resolvedAt = null;
      data.reopenCount = before.reopenCount + 1;
    }
  }

  if (patch.supportLevel !== undefined && ![1, 2, 3].includes(patch.supportLevel)) {
    throw new TicketError(400, "Nível de suporte inválido (1, 2 ou 3)");
  }

  track("priority", "PRIORITY");
  track("supportLevel", "LEVEL");
  track("assigneeId", "ASSIGNEE");
  track("groupId", "GROUP");
  track("subject", "SUBJECT");
  track("description", null);
  track("dueAt", null);
  // Categoria e subcategoria num só evento (a subcategoria depende da categoria).
  const catBefore = `${before.categoryId ?? ""}/${before.subcategoryId ?? ""}`;
  track("categoryId", null);
  track("subcategoryId", null);
  const catAfter = `${(patch.categoryId !== undefined ? patch.categoryId : before.categoryId) ?? ""}/${
    (patch.subcategoryId !== undefined ? patch.subcategoryId : before.subcategoryId) ?? ""
  }`;
  if (catAfter !== catBefore) events.push({ type: "CATEGORY", fromValue: catBefore, toValue: catAfter });

  return { data, events, reopened };
}

/** Confirma que as referências pertencem ao tenant. Lança TicketError 400. */
export async function validateRefs(
  tenantId: string,
  refs: { [K in "contactId" | "assigneeId" | "groupId" | "categoryId" | "subcategoryId"]?: string | null | undefined }
): Promise<void> {
  const checks: Promise<string | null>[] = [];
  if (refs.contactId) checks.push(prisma.contact.count({ where: { id: refs.contactId, tenantId } }).then((n) => (n ? null : "Contacto não encontrado")));
  if (refs.assigneeId) checks.push(prisma.tenantUser.count({ where: { id: refs.assigneeId, tenantId } }).then((n) => (n ? null : "Utilizador não encontrado")));
  if (refs.groupId) checks.push(prisma.extensionGroup.count({ where: { id: refs.groupId, tenantId } }).then((n) => (n ? null : "Grupo não encontrado")));
  if (refs.categoryId) checks.push(prisma.callCategory.count({ where: { id: refs.categoryId, tenantId, parentId: null } }).then((n) => (n ? null : "Categoria inválida")));
  if (refs.subcategoryId) {
    if (!refs.categoryId) throw new TicketError(400, "Subcategoria sem categoria");
    checks.push(
      prisma.callCategory
        .count({ where: { id: refs.subcategoryId, tenantId, parentId: refs.categoryId } })
        .then((n) => (n ? null : "Subcategoria não pertence à categoria"))
    );
  }
  const err = (await Promise.all(checks)).find(Boolean);
  if (err) throw new TicketError(400, err);
}

export interface CreateTicketInput {
  subject: string;
  description?: string | null | undefined;
  priority?: TicketPriority | undefined;
  supportLevel?: number | undefined;
  contactId?: string | null | undefined;
  assigneeId?: string | null | undefined;
  groupId?: string | null | undefined;
  categoryId?: string | null | undefined;
  subcategoryId?: string | null | undefined;
  dueAt?: Date | null | undefined;
  source?: string | undefined;
  callId?: string | null | undefined;
  conversationId?: string | null | undefined;
}

/**
 * Cria o ticket com número sequencial do tenant e, se vier, liga-lhe a chamada
 * ou conversa de origem (o contacto vem dela quando não é indicado).
 */
export async function createTicket(tenantId: string, authorId: string | null, input: CreateTicketInput) {
  let contactId = input.contactId ?? null;
  if (input.callId) {
    const call = await prisma.call.findFirst({ where: { id: input.callId, tenantId }, select: { contactId: true } });
    if (!call) throw new TicketError(400, "Chamada não encontrada");
    contactId ??= call.contactId;
  }
  if (input.conversationId) {
    const conv = await prisma.conversation.findFirst({ where: { id: input.conversationId, tenantId }, select: { contactId: true } });
    if (!conv) throw new TicketError(400, "Conversa não encontrada");
    contactId ??= conv.contactId;
  }
  await validateRefs(tenantId, { ...input, contactId });

  return prisma.$transaction(async (tx) => {
    const { ticketSeq } = await tx.tenant.update({ where: { id: tenantId }, data: { ticketSeq: { increment: 1 } }, select: { ticketSeq: true } });
    const ticket = await tx.ticket.create({
      data: {
        tenantId,
        number: ticketSeq,
        subject: input.subject,
        description: input.description ?? null,
        priority: input.priority ?? "MEDIUM",
        supportLevel: input.supportLevel ?? 1,
        contactId,
        assigneeId: input.assigneeId ?? null,
        groupId: input.groupId ?? null,
        categoryId: input.categoryId ?? null,
        subcategoryId: input.subcategoryId ?? null,
        dueAt: input.dueAt ?? null,
        source: input.source ?? (input.callId ? "CALL" : "MANUAL"),
        createdById: authorId,
        events: { create: { type: "CREATED", authorId } },
      },
    });
    if (input.callId) {
      await tx.call.update({ where: { id: input.callId }, data: { ticketId: ticket.id } });
      await tx.ticketEvent.create({ data: { ticketId: ticket.id, type: "LINKED", toValue: `call:${input.callId}`, authorId } });
    }
    if (input.conversationId) {
      await tx.conversation.update({ where: { id: input.conversationId }, data: { ticketId: ticket.id } });
      await tx.ticketEvent.create({ data: { ticketId: ticket.id, type: "LINKED", toValue: `conversation:${input.conversationId}`, authorId } });
    }
    return ticket;
  });
}

/**
 * Aplica uma alteração com bloqueio optimista: se `expectedUpdatedAt` não bate
 * certo, outra pessoa mexeu primeiro e devolve 409.
 */
export async function updateTicket(tenantId: string, id: string, authorId: string | null, patch: TicketPatch, expectedUpdatedAt?: Date) {
  const before = await prisma.ticket.findFirst({ where: { id, tenantId } });
  if (!before) throw new TicketError(404, "Ticket não encontrado");
  if (expectedUpdatedAt && before.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw new TicketError(409, "O ticket foi alterado por outra pessoa");
  }
  // A subcategoria valida-se contra a categoria final (a nova ou a que já tem).
  const categoryId = patch.categoryId !== undefined ? patch.categoryId : before.categoryId;
  if (patch.categoryId !== undefined && patch.subcategoryId === undefined && patch.categoryId !== before.categoryId) {
    patch = { ...patch, subcategoryId: null };
  }
  await validateRefs(tenantId, {
    ...(patch.assigneeId !== undefined && { assigneeId: patch.assigneeId }),
    ...(patch.groupId !== undefined && { groupId: patch.groupId }),
    ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
    ...(patch.subcategoryId !== undefined && { subcategoryId: patch.subcategoryId, categoryId }),
  });

  const { data, events, reopened } = planTicketUpdate(before, patch);
  if (events.length === 0 && Object.keys(data).length === 0) return { ticket: before, changed: false, reopened };

  const { count } = await prisma.ticket.updateMany({
    where: { id, tenantId, updatedAt: before.updatedAt },
    data: data as Prisma.TicketUncheckedUpdateManyInput,
  });
  if (count === 0) throw new TicketError(409, "O ticket foi alterado por outra pessoa");
  if (events.length) {
    await prisma.ticketEvent.createMany({ data: events.map((e) => ({ ...e, ticketId: id, authorId })) });
  }
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id } });
  return { ticket, changed: true, reopened };
}

export async function addTicketNote(tenantId: string, id: string, authorId: string | null, body: string) {
  const ticket = await prisma.ticket.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!ticket) throw new TicketError(404, "Ticket não encontrado");
  const [event] = await prisma.$transaction([
    prisma.ticketEvent.create({ data: { ticketId: id, type: "NOTE", body, authorId } }),
    // Mexe no updatedAt para a lista ordenar pela última actividade.
    prisma.ticket.update({ where: { id }, data: { updatedAt: new Date() } }),
  ]);
  return event;
}

/** Liga (ou desliga, com ticketId null) uma chamada ou conversa a um ticket. */
export async function linkInteraction(
  tenantId: string,
  ticketId: string,
  authorId: string | null,
  target: { callId?: string | undefined; conversationId?: string | undefined },
  link: boolean
) {
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, tenantId }, select: { id: true, contactId: true } });
  if (!ticket) throw new TicketError(404, "Ticket não encontrado");
  const ref = target.callId ? `call:${target.callId}` : `conversation:${target.conversationId}`;
  const where = { tenantId, ...(link ? {} : { ticketId }) };
  const data = { ticketId: link ? ticketId : null };
  const { count } = target.callId
    ? await prisma.call.updateMany({ where: { ...where, id: target.callId }, data })
    : await prisma.conversation.updateMany({ where: { ...where, id: target.conversationId! }, data });
  if (count === 0) throw new TicketError(404, target.callId ? "Chamada não encontrada" : "Conversa não encontrada");
  await prisma.ticketEvent.create({
    data: { ticketId, type: link ? "LINKED" : "UNLINKED", ...(link ? { toValue: ref } : { fromValue: ref }), authorId },
  });
}
