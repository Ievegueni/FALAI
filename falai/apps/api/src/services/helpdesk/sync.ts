import { Queue, Worker, type Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { prisma, type Prisma, type TicketEventType, type HelpdeskConnection } from "@falai/db";
import { config } from "../../config.js";
import { decryptSecret } from "../crypto.service.js";
import {
  FreshdeskClient,
  FreshdeskError,
  fromFdPriority,
  fromFdSource,
  fromFdStatus,
  toFdPriority,
  toFdSource,
  toFdStatus,
  type FdTicket,
} from "./freshdesk.js";

/**
 * Sincronização de tickets com o helpdesk externo do cliente (fase 3 do plano
 * do centro de atendimento — ver docs/PLANO-CENTRO-ATENDIMENTO.md §2).
 *
 *   Falaí → Freshdesk: grava-se primeiro cá (o agente nunca fica à espera) e
 *     uma fila envia; com novas tentativas se o Freshdesk falhar.
 *   Freshdesk → Falaí: webhook (regra de automação deles) + reconciliação a
 *     cada 5 min, que também importa os tickets que já lá existem.
 *
 * Alterações locais por enviar (updatedAt > externalSyncedAt) não são pisadas
 * pela vinda de lá: seguem primeiro e o Freshdesk recebe-as.
 * ponytail: o Worker corre dentro da API (precisa do mesmo código); passa para
 * o worker se a carga crescer.
 */

export const FRESHDESK = "FRESHDESK";
const QUEUE = "helpdesk-sync";
const RECONCILE_MS = 5 * 60_000;
const FIRST_IMPORT_DAYS = 30;

type JobData =
  | { kind: "push"; tenantId: string; ticketId: string }
  | { kind: "note"; tenantId: string; eventId: string }
  | { kind: "pull"; tenantId: string; externalId: string };

let queue: Queue<JobData> | null = null;
const getQueue = () => (queue ??= new Queue<JobData>(QUEUE, { connection: { url: config.REDIS_URL } }));
const jobOpts = { attempts: 6, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: true, removeOnFail: 200 };

/** Ligação activa do cliente (null = tickets nativos). */
export async function activeConnection(tenantId: string): Promise<HelpdeskConnection | null> {
  return prisma.helpdeskConnection.findFirst({ where: { tenantId, enabled: true, provider: FRESHDESK } });
}

export const clientFor = (c: Pick<HelpdeskConnection, "domain" | "apiKey">) => new FreshdeskClient(c.domain, decryptSecret(c.apiKey));

// ─── Enfileirar (chamado pelo serviço de tickets) ────────────────────────────

/** O ticket mudou cá: enviar ao helpdesk, se o cliente tiver um. Nunca lança. */
export async function enqueueTicketPush(tenantId: string, ticketId: string, log?: FastifyBaseLogger): Promise<void> {
  try {
    if (!(await activeConnection(tenantId))) return;
    // jobId: vários cliques seguidos dão um só envio (o envio lê o estado actual).
    await getQueue().add("push", { kind: "push", tenantId, ticketId }, { ...jobOpts, jobId: `push-${ticketId}` });
  } catch (err) {
    log?.warn({ err, ticketId }, "helpdesk.enqueue_failed");
  }
}

export async function enqueueNotePush(tenantId: string, eventId: string, log?: FastifyBaseLogger): Promise<void> {
  try {
    if (!(await activeConnection(tenantId))) return;
    await getQueue().add("note", { kind: "note", tenantId, eventId }, { ...jobOpts, jobId: `note-${eventId}` });
  } catch (err) {
    log?.warn({ err, eventId }, "helpdesk.enqueue_failed");
  }
}

/** Webhook do helpdesk: ir buscar o ticket e aplicar cá. */
export async function enqueuePull(tenantId: string, externalId: string): Promise<void> {
  await getQueue().add("pull", { kind: "pull", tenantId, externalId }, { ...jobOpts, jobId: `pull-${externalId}-${Date.now()}` });
}

// ─── Mapas de agentes e grupos (por email e por nome) ────────────────────────

const MAP_TTL_MS = 10 * 60_000;
const maps = new Map<string, { at: number; agentByEmail: Map<string, number>; emailByAgent: Map<number, string>; groupByName: Map<string, number>; nameByGroup: Map<number, string> }>();

async function directory(c: HelpdeskConnection) {
  const hit = maps.get(c.tenantId);
  if (hit && Date.now() - hit.at < MAP_TTL_MS) return hit;
  const fd = clientFor(c);
  const [agents, groups] = await Promise.all([fd.agents(), fd.groups()]);
  const norm = (s: string) => s.trim().toLowerCase();
  const d = {
    at: Date.now(),
    agentByEmail: new Map(agents.filter((a) => a.contact.email).map((a) => [norm(a.contact.email!), a.id])),
    emailByAgent: new Map(agents.filter((a) => a.contact.email).map((a) => [a.id, norm(a.contact.email!)])),
    groupByName: new Map(groups.map((g) => [norm(g.name), g.id])),
    nameByGroup: new Map(groups.map((g) => [g.id, norm(g.name)])),
  };
  maps.set(c.tenantId, d);
  return d;
}
export const forgetDirectory = (tenantId: string) => maps.delete(tenantId);

// ─── Falaí → Freshdesk ───────────────────────────────────────────────────────

/** Corpo do ticket para o Freshdesk a partir do estado local. Pura. */
export function fdTicketBody(
  t: { subject: string; description: string | null; status: Parameters<typeof toFdStatus>[0]; priority: Parameters<typeof toFdPriority>[0]; categoryName: string | null; subcategoryName: string | null; supportLevel: number },
  ids: { responderId: number | null; groupId: number | null }
): Record<string, unknown> {
  const tags = [`nivel-${t.supportLevel}`, ...(t.categoryName ? [[t.categoryName, t.subcategoryName].filter(Boolean).join(" / ")] : [])];
  return {
    subject: t.subject,
    status: toFdStatus(t.status),
    priority: toFdPriority(t.priority),
    responder_id: ids.responderId,
    ...(ids.groupId !== null && { group_id: ids.groupId }),
    tags,
  };
}

async function pushTicket(tenantId: string, ticketId: string) {
  const c = await activeConnection(tenantId);
  if (!c) return;
  const t = await prisma.ticket.findFirst({
    where: { id: ticketId, tenantId },
    include: {
      contact: { select: { name: true, email: true, phone: true } },
      assignee: { select: { email: true } },
      group: { select: { name: true } },
      category: { select: { name: true } },
      subcategory: { select: { name: true } },
      calls: { take: 1, orderBy: { createdAt: "desc" }, select: { fromNumber: true } },
    },
  });
  if (!t) return;
  if (t.externalSyncedAt && t.updatedAt <= t.externalSyncedAt && t.externalId) return; // nada de novo
  const dir = await directory(c);
  const body = fdTicketBody(
    { ...t, categoryName: t.category?.name ?? null, subcategoryName: t.subcategory?.name ?? null },
    {
      responderId: t.assignee?.email ? (dir.agentByEmail.get(t.assignee.email.toLowerCase()) ?? null) : null,
      groupId: t.group ? (dir.groupByName.get(t.group.name.trim().toLowerCase()) ?? null) : null,
    }
  );
  const fd = clientFor(c);
  let externalId = t.externalId;
  if (!externalId) {
    // O Freshdesk exige quem pediu: email, ou telefone com nome.
    const phone = t.contact?.phone ?? t.calls[0]?.fromNumber ?? null;
    const requester = t.contact?.email
      ? { email: t.contact.email, ...(t.contact.name && { name: t.contact.name }) }
      : phone
        ? { phone, name: t.contact?.name || phone }
        : null;
    if (!requester) throw new FreshdeskError(400, "O ticket não tem cliente com email ou telefone — o Freshdesk exige um");
    const created = await fd.createTicket({ ...body, ...requester, description: t.description || t.subject, source: toFdSource(t.source) });
    externalId = String(created.id);
  } else {
    await fd.updateTicket(externalId, body);
  }
  // Marca como enviado sem mexer no updatedAt (que é o que se compara). Se o
  // ticket mudou entretanto, count = 0 e volta para a fila.
  const { count } = await prisma.ticket.updateMany({
    where: { id: t.id, updatedAt: t.updatedAt },
    data: { externalSystem: FRESHDESK, externalId, externalSyncedAt: t.updatedAt, updatedAt: t.updatedAt },
  });
  if (count === 0) {
    await prisma.ticket.updateMany({ where: { id: t.id, externalId: null }, data: { externalId } });
    await getQueue().add("push", { kind: "push", tenantId, ticketId }, { ...jobOpts, jobId: `push-${ticketId}-${Date.now()}` });
  }
}

async function pushNote(tenantId: string, eventId: string) {
  const c = await activeConnection(tenantId);
  if (!c) return;
  const e = await prisma.ticketEvent.findFirst({
    where: { id: eventId, ticket: { tenantId } },
    select: { body: true, author: { select: { name: true } }, ticket: { select: { id: true, externalId: true } } },
  });
  if (!e?.body) return;
  // Ainda não existe lá: tenta-se outra vez depois do envio do ticket.
  if (!e.ticket.externalId) throw new FreshdeskError(409, "Ticket ainda não criado no Freshdesk");
  await clientFor(c).addNote(e.ticket.externalId, `${e.author?.name ?? "Falaí"}: ${e.body}`);
}

// ─── Freshdesk → Falaí ───────────────────────────────────────────────────────

/** Contacto local do requerente (por email ou telefone); cria-o se não existir. */
async function contactFor(tenantId: string, r: FdTicket["requester"]): Promise<string | null> {
  if (!r) return null;
  const phone = r.phone || r.mobile || null;
  const found = await prisma.contact.findFirst({
    where: { tenantId, OR: [...(r.email ? [{ email: r.email }] : []), ...(phone ? [{ phone }, { phones: { some: { phone } } }] : [])] },
    select: { id: true },
  });
  if (found) return found.id;
  if (!r.email && !phone) return null;
  const created = await prisma.contact
    .create({ data: { tenantId, name: r.name ?? null, email: r.email ?? null, phone }, select: { id: true } })
    .catch(() => null); // corrida com outro import: fica sem contacto, o próximo apanha
  return created?.id ?? null;
}

/** Aplica um ticket do Freshdesk cá (cria o espelho se ainda não existir). */
export async function applyFdTicket(c: HelpdeskConnection, fdt: FdTicket) {
  const tenantId = c.tenantId;
  const externalId = String(fdt.id);
  const dir = await directory(c);
  const email = fdt.responder_id ? dir.emailByAgent.get(fdt.responder_id) : null;
  const groupName = fdt.group_id ? dir.nameByGroup.get(fdt.group_id) : null;
  const [assignee, group] = await Promise.all([
    email ? prisma.tenantUser.findFirst({ where: { tenantId, email: { equals: email, mode: "insensitive" } }, select: { id: true } }) : null,
    groupName ? prisma.extensionGroup.findFirst({ where: { tenantId, name: { equals: groupName, mode: "insensitive" } }, select: { id: true } }) : null,
  ]);
  const next = {
    subject: fdt.subject,
    status: fromFdStatus(fdt.status),
    priority: fromFdPriority(fdt.priority),
    assigneeId: assignee?.id ?? null,
    groupId: group?.id ?? null,
  };
  const now = new Date();
  const local = await prisma.ticket.findFirst({ where: { tenantId, externalSystem: FRESHDESK, externalId } });

  if (!local) {
    const contactId = await contactFor(tenantId, fdt.requester);
    await prisma.$transaction(async (tx) => {
      const { ticketSeq } = await tx.tenant.update({ where: { id: tenantId }, data: { ticketSeq: { increment: 1 } }, select: { ticketSeq: true } });
      await tx.ticket.create({
        data: {
          tenantId,
          number: ticketSeq,
          ...next,
          description: fdt.description_text ?? null,
          contactId,
          source: fromFdSource(fdt.source),
          externalSystem: FRESHDESK,
          externalId,
          createdAt: new Date(fdt.created_at),
          ...(next.status === "RESOLVED" || next.status === "CLOSED" ? { resolvedAt: new Date(fdt.updated_at) } : {}),
          ...(next.status === "CLOSED" ? { closedAt: new Date(fdt.updated_at) } : {}),
          updatedAt: now,
          externalSyncedAt: now,
          events: { create: { type: "CREATED", body: "Importado do Freshdesk" } },
        },
      });
    });
    return "created" as const;
  }

  // Alterações cá ainda por enviar: seguem primeiro, não se pisam.
  if (!local.externalSyncedAt || local.updatedAt > local.externalSyncedAt) return "skipped" as const;

  const events: { type: TicketEventType; fromValue: string | null; toValue: string | null }[] = [];
  const data: Prisma.TicketUncheckedUpdateInput = {};
  const track = (key: keyof typeof next, type: TicketEventType) => {
    if (next[key] === local[key]) return;
    (data as Record<string, unknown>)[key] = next[key];
    events.push({ type, fromValue: (local[key] as string | null) ?? null, toValue: (next[key] as string | null) ?? null });
  };
  track("status", "STATUS");
  track("priority", "PRIORITY");
  track("subject", "SUBJECT");
  track("assigneeId", "ASSIGNEE");
  track("groupId", "GROUP");
  if (events.length === 0) return "unchanged" as const;
  if (data.status === "RESOLVED" || data.status === "CLOSED") data.resolvedAt = local.resolvedAt ?? now;
  if (data.status === "CLOSED") data.closedAt = now;
  if (data.status && data.status !== "RESOLVED" && data.status !== "CLOSED") {
    data.resolvedAt = null;
    data.closedAt = null;
    if (local.status === "RESOLVED" || local.status === "CLOSED") data.reopenCount = local.reopenCount + 1;
  }
  await prisma.ticket.update({ where: { id: local.id }, data: { ...data, updatedAt: now, externalSyncedAt: now } });
  await prisma.ticketEvent.createMany({ data: events.map((e) => ({ ...e, ticketId: local.id, body: "Alterado no Freshdesk" })) });
  return "updated" as const;
}

/** Tickets alterados no Freshdesk desde a última vez (e, na 1.ª, os últimos 30 dias). */
export async function reconcile(c: HelpdeskConnection, log: FastifyBaseLogger) {
  const since = new Date((c.lastSyncAt ?? new Date(Date.now() - FIRST_IMPORT_DAYS * 86_400_000)).getTime() - 60_000);
  const fd = clientFor(c);
  let newest = c.lastSyncAt ?? since;
  const counts = { created: 0, updated: 0, skipped: 0, unchanged: 0 };
  for (let page = 1; page <= 10; page++) {
    const rows = await fd.updatedSince(since, page);
    for (const t of rows) {
      counts[await applyFdTicket(c, t)]++;
      const at = new Date(t.updated_at);
      if (at > newest) newest = at;
    }
    if (rows.length < 100) break;
  }
  await prisma.helpdeskConnection.update({ where: { id: c.id }, data: { lastSyncAt: newest, lastError: null, lastErrorAt: null } });
  log.info({ tenantId: c.tenantId, ...counts }, "helpdesk.reconciled");
  return counts;
}

async function recordError(tenantId: string, err: unknown) {
  await prisma.helpdeskConnection
    .updateMany({ where: { tenantId }, data: { lastError: (err as Error).message?.slice(0, 500) ?? String(err), lastErrorAt: new Date() } })
    .catch(() => {});
}

// ─── Arranque: worker da fila + reconciliação periódica ──────────────────────

export function startHelpdeskSync(log: FastifyBaseLogger): () => Promise<void> {
  const worker = new Worker<JobData>(
    QUEUE,
    async (job: Job<JobData>) => {
      const d = job.data;
      if (d.kind === "push") return pushTicket(d.tenantId, d.ticketId);
      if (d.kind === "note") return pushNote(d.tenantId, d.eventId);
      const c = await activeConnection(d.tenantId);
      if (c) await applyFdTicket(c, await clientFor(c).getTicket(d.externalId));
    },
    { connection: { url: config.REDIS_URL }, concurrency: 2 }
  );
  worker.on("failed", (job, err) => {
    log.warn({ err, job: job?.name, data: job?.data, attempts: job?.attemptsMade }, "helpdesk.job_failed");
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void recordError(job.data.tenantId, err);
  });

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const c of await prisma.helpdeskConnection.findMany({ where: { enabled: true, provider: FRESHDESK } })) {
        await reconcile(c, log).catch(async (err) => {
          log.warn({ err, tenantId: c.tenantId }, "helpdesk.reconcile_failed");
          await recordError(c.tenantId, err);
        });
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), RECONCILE_MS);
  return async () => {
    clearInterval(timer);
    await worker.close();
  };
}
