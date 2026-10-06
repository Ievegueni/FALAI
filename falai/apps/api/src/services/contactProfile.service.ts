/**
 * Perfil completo do cliente (melhoria 5/6). O screen pop da melhoria 3 é a
 * versão resumida; aqui junta-se tudo: cabeçalho, resumo calculado no
 * servidor, histórico filtrável, tipificações e notas, e a união de
 * contactos duplicados.
 *
 * Estado de uma chamada, igual para entrada e saída:
 * - atendida: alguém atendeu (answeredAt) ou terminou como COMPLETED/ESCALATED;
 * - recusada: ninguém atendeu e uma extensão recusou (melhoria 1);
 * - perdida: terminou sem ninguém atender;
 * - em curso: ainda não terminou.
 */
import { z } from "zod";
import { prisma, type Prisma } from "@falai/db";
import { normalizeAoPhone } from "@falai/shared";
import { dayBounds } from "./callsFilter.service.js";
import { phoneVariants } from "./callerLookup.service.js";

export type CallState = "ANSWERED" | "MISSED" | "REJECTED" | "IN_PROGRESS";

const DONE_OK = new Set(["COMPLETED", "ESCALATED"]);
const LIVE = new Set(["QUEUED", "DIALING", "RINGING", "IN_PROGRESS"]);

export function callState(c: { answeredAt: Date | null; status: string; legOutcomes: (string | null)[] }): CallState {
  if (c.answeredAt || DONE_OK.has(c.status)) return LIVE.has(c.status) ? "IN_PROGRESS" : "ANSWERED";
  if (LIVE.has(c.status)) return "IN_PROGRESS";
  return c.legOutcomes.includes("REJECTED") ? "REJECTED" : "MISSED";
}

/** O mesmo critério de callState, em WHERE (para filtrar no servidor). */
export function stateWhere(state: Exclude<CallState, "IN_PROGRESS">): Prisma.CallWhereInput {
  const notLive = { status: { notIn: [...LIVE] as never[] } };
  const answered: Prisma.CallWhereInput = { OR: [{ answeredAt: { not: null } }, { status: { in: [...DONE_OK] as never[] } }] };
  if (state === "ANSWERED") return { AND: [answered, notLive] };
  const notAnswered: Prisma.CallWhereInput = { answeredAt: null, status: { notIn: [...DONE_OK, ...LIVE] as never[] } };
  const rejected = { legs: { some: { outcome: "REJECTED" as const } } };
  return state === "REJECTED" ? { AND: [notAnswered, rejected] } : { AND: [notAnswered, { NOT: rejected }] };
}

// ─── Histórico (filtros + paginação) ─────────────────────────────────────────

export const historyFilterSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  state: z.enum(["ANSWERED", "MISSED", "REJECTED"]).optional(),
  categoryId: z.string().optional(), // categoria ou subcategoria
  extensionId: z.string().optional(), // agente que atendeu
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type HistoryFilter = z.infer<typeof historyFilterSchema>;

export function historyWhere(tenantId: string, contactId: string, f: HistoryFilter): Prisma.CallWhereInput {
  const and: Prisma.CallWhereInput[] = [{ tenantId, contactId }];
  const range = dayBounds(f.from, f.to);
  if (range.gte || range.lte) and.push({ startedAt: range });
  if (f.state) and.push(stateWhere(f.state));
  if (f.categoryId) and.push({ legs: { some: { OR: [{ categoryId: f.categoryId }, { subcategoryId: f.categoryId }] } } });
  if (f.extensionId) and.push({ legs: { some: { extensionId: f.extensionId, outcome: "ANSWERED" } } });
  return { AND: and };
}

export const historySelect = {
  id: true,
  kind: true,
  startedAt: true,
  createdAt: true,
  answeredAt: true,
  endedAt: true,
  durationSecs: true,
  status: true,
  group: { select: { name: true } },
  legs: {
    select: {
      extensionId: true,
      extensionNumber: true,
      outcome: true,
      typingNote: true,
      typedAt: true,
      extension: { select: { displayName: true } },
      category: { select: { id: true, name: true } },
      subcategory: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.CallSelect;
export type HistoryCall = Prisma.CallGetPayload<{ select: typeof historySelect }>;

const agentName = (l: { extensionNumber: string; extension: { displayName: string | null } | null }) =>
  l.extension?.displayName && l.extension.displayName !== l.extensionNumber
    ? `${l.extensionNumber} ${l.extension.displayName}`
    : l.extensionNumber;

const typingLabel = (l: { category: { name: string } | null; subcategory: { name: string } | null }) =>
  l.category ? [l.category.name, l.subcategory?.name].filter(Boolean).join(" › ") : null;

export function mapHistoryRow(c: HistoryCall) {
  const answered = c.legs.find((l) => l.outcome === "ANSWERED");
  const at = c.startedAt ?? c.createdAt;
  return {
    id: c.id,
    at,
    direction: c.kind === "INBOUND" ? ("INBOUND" as const) : ("OUTBOUND" as const),
    kind: c.kind,
    agent: answered ? agentName(answered) : null,
    group: c.group?.name ?? null,
    durationSecs:
      c.answeredAt && c.endedAt ? Math.round((c.endedAt.getTime() - c.answeredAt.getTime()) / 1000) : c.durationSecs,
    state: callState({ answeredAt: c.answeredAt, status: c.status, legOutcomes: c.legs.map((l) => l.outcome) }),
    status: c.status,
    typing: answered ? typingLabel(answered) : null,
    note: answered?.typingNote ?? null,
  };
}

// ─── Resumo e tipificações (função pura sobre as chamadas do contacto) ───────

export interface ProfileStats {
  total: number;
  answered: number;
  missed: number;
  rejected: number;
  firstContactAt: Date | null;
  lastContactAt: Date | null;
  topTyping: { label: string; count: number } | null;
  lastTyping: { label: string; at: Date; note: string | null } | null;
  topAgent: { extensionId: string | null; name: string; count: number } | null;
  /** Distribuição por categoria (com as subcategorias), contagem e %. */
  typings: { id: string; name: string; count: number; pct: number; subs: { id: string; name: string; count: number; pct: number }[] }[];
  typedTotal: number;
  /** Linha temporal: tipificações por data. */
  timeline: { at: Date; label: string; note: string | null; agent: string; callId: string }[];
  /** Para os filtros do histórico: agentes e categorias que aparecem neste cliente. */
  agents: { extensionId: string; name: string }[];
  categories: { id: string; name: string }[];
}

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

export function profileStats(calls: HistoryCall[]): ProfileStats {
  let answered = 0;
  let missed = 0;
  let rejected = 0;
  let first: Date | null = null;
  let last: Date | null = null;
  const byTyping = new Map<string, number>();
  const byAgent = new Map<string, { extensionId: string | null; name: string; count: number }>();
  const cats = new Map<string, { id: string; name: string; count: number; subs: Map<string, { id: string; name: string; count: number }> }>();
  const timeline: ProfileStats["timeline"] = [];

  for (const c of calls) {
    const at = c.startedAt ?? c.createdAt;
    if (!first || at < first) first = at;
    if (!last || at > last) last = at;
    const state = callState({ answeredAt: c.answeredAt, status: c.status, legOutcomes: c.legs.map((l) => l.outcome) });
    if (state === "ANSWERED") answered++;
    else if (state === "MISSED") missed++;
    else if (state === "REJECTED") rejected++;

    const leg = c.legs.find((l) => l.outcome === "ANSWERED");
    if (!leg) continue;
    const name = agentName(leg);
    const key = leg.extensionId ?? `n:${leg.extensionNumber}`;
    const a = byAgent.get(key) ?? { extensionId: leg.extensionId, name, count: 0 };
    a.count++;
    byAgent.set(key, a);

    const label = typingLabel(leg);
    if (!label || !leg.category) continue;
    byTyping.set(label, (byTyping.get(label) ?? 0) + 1);
    const cat = cats.get(leg.category.id) ?? { ...leg.category, count: 0, subs: new Map() };
    cat.count++;
    if (leg.subcategory) {
      const sub = cat.subs.get(leg.subcategory.id) ?? { ...leg.subcategory, count: 0 };
      sub.count++;
      cat.subs.set(leg.subcategory.id, sub);
    }
    cats.set(leg.category.id, cat);
    timeline.push({ at: leg.typedAt ?? at, label, note: leg.typingNote, agent: name, callId: c.id });
  }

  const top = <T extends { count: number }>(xs: Iterable<T>) => [...xs].sort((x, y) => y.count - x.count)[0] ?? null;
  const topTyping = top([...byTyping].map(([label, count]) => ({ label, count })));
  timeline.sort((x, y) => x.at.getTime() - y.at.getTime());
  const lastT = timeline.at(-1);
  const typedTotal = timeline.length;

  return {
    total: calls.length,
    answered,
    missed,
    rejected,
    firstContactAt: first,
    lastContactAt: last,
    topTyping,
    lastTyping: lastT ? { label: lastT.label, at: lastT.at, note: lastT.note } : null,
    topAgent: top(byAgent.values()),
    typings: [...cats.values()]
      .sort((x, y) => y.count - x.count)
      .map((c) => ({
        id: c.id,
        name: c.name,
        count: c.count,
        pct: pct(c.count, typedTotal),
        subs: [...c.subs.values()].sort((x, y) => y.count - x.count).map((s) => ({ ...s, pct: pct(s.count, c.count) })),
      })),
    typedTotal,
    timeline,
    agents: [...byAgent.values()].filter((a): a is { extensionId: string; name: string; count: number } => !!a.extensionId).map(({ extensionId, name }) => ({ extensionId, name })),
    categories: [...cats.values()].flatMap((c) => [{ id: c.id, name: c.name }, ...[...c.subs.values()].map((s) => ({ id: s.id, name: `${c.name} › ${s.name}` }))]),
  };
}

// ─── BD ──────────────────────────────────────────────────────────────────────

const MAX_STATS_CALLS = 5000; // ponytail: resumo sobre as últimas 5000 chamadas; agregar em SQL se um cliente passar disto

export async function buildProfile(tenantId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      attributes: true,
      optedOutAt: true,
      optOutReason: true,
      createdAt: true,
      phones: { select: { id: true, phone: true, label: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!contact) return null;

  const [calls, notes, tickets] = await Promise.all([
    prisma.call.findMany({ where: { tenantId, contactId }, orderBy: { startedAt: "desc" }, take: MAX_STATS_CALLS, select: historySelect }),
    contactNotes(tenantId, contactId),
    prisma.ticket.findMany({
      where: { tenantId, contactId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, number: true, subject: true, status: true, priority: true, supportLevel: true, updatedAt: true },
    }),
  ]);
  const stats = profileStats(calls);
  return {
    contact: { ...contact, phone: contact.phone ? (normalizeAoPhone(contact.phone) ?? contact.phone) : null },
    summary: {
      total: stats.total,
      answered: stats.answered,
      missed: stats.missed,
      rejected: stats.rejected,
      firstContactAt: stats.firstContactAt,
      lastContactAt: stats.lastContactAt,
      topTyping: stats.topTyping,
      lastTyping: stats.lastTyping,
      topAgent: stats.topAgent,
    },
    typings: { total: stats.typedTotal, distribution: stats.typings, timeline: stats.timeline },
    filters: { agents: stats.agents, categories: stats.categories },
    notes,
    tickets,
  };
}

/** Notas do cliente (melhoria 3) e notas da tipificação de cada chamada, mais recentes primeiro. */
export async function contactNotes(tenantId: string, contactId: string) {
  const [own, typed] = await Promise.all([
    prisma.contactNote.findMany({
      where: { tenantId, contactId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, body: true, createdAt: true, authorId: true, callId: true },
    }),
    prisma.callLeg.findMany({
      where: { tenantId, call: { contactId }, typingNote: { not: null } },
      orderBy: { typedAt: "desc" },
      take: 200,
      select: { id: true, typingNote: true, typedAt: true, ringStartedAt: true, typedById: true, callId: true, extensionNumber: true, extension: { select: { displayName: true } } },
    }),
  ]);
  const userIds = [...new Set([...own.map((n) => n.authorId), ...typed.map((l) => l.typedById).filter((x): x is string => !!x)])];
  const users = new Map(
    (await prisma.tenantUser.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  return [
    ...own.map((n) => ({ id: n.id, source: "NOTE" as const, body: n.body, at: n.createdAt, author: users.get(n.authorId) ?? null, callId: n.callId })),
    ...typed.map((l) => ({
      id: l.id,
      source: "TYPING" as const,
      body: l.typingNote!,
      at: l.typedAt ?? l.ringStartedAt,
      author: (l.typedById && users.get(l.typedById)) || agentName(l),
      callId: l.callId,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ─── Pesquisa ────────────────────────────────────────────────────────────────

/**
 * Pesquisa de clientes. Número completo → normaliza e procura exactamente
 * (índices únicos, inclui números extra). Senão, parte do nome ou do número
 * (índices trigram pg_trgm).
 */
export function contactSearchWhere(tenantId: string, q: string): Prisma.ContactWhereInput {
  const term = q.trim();
  const national = normalizeAoPhone(term);
  if (national) {
    const v = phoneVariants(national);
    return { tenantId, OR: [{ phone: { in: v } }, { phones: { some: { phone: { in: v } } } }] };
  }
  const digits = term.replace(/\D/g, "");
  return {
    tenantId,
    OR: [
      { name: { contains: term, mode: "insensitive" } },
      ...(digits.length >= 3 ? [{ phone: { contains: digits } }, { phones: { some: { phone: { contains: digits } } } }] : []),
    ],
  };
}

// ─── União de duplicados ─────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

/**
 * Junta `dropId` em `keepId`: o histórico todo passa para o que fica, o
 * número do outro fica como número extra, nome/email/Telegram só preenchem o
 * que faltar e o opt-out mantém-se se qualquer um o tinha. O duplicado é
 * apagado; quem chama regista o snapshot na auditoria.
 */
export async function mergeContacts(tx: Tx, tenantId: string, keepId: string, dropId: string) {
  if (keepId === dropId) throw new MergeError("Escolha dois contactos diferentes");
  const [keep, drop] = await Promise.all([
    tx.contact.findFirst({ where: { id: keepId, tenantId } }),
    tx.contact.findFirst({ where: { id: dropId, tenantId } }),
  ]);
  if (!keep || !drop) throw new MergeError("Contacto não encontrado");

  const moved = { tenantId, contactId: dropId };
  const to = { contactId: keepId };
  const [calls, sms, conversations, notes, supervision, phones, tickets] = await Promise.all([
    tx.call.updateMany({ where: moved, data: to }),
    tx.smsMessage.updateMany({ where: moved, data: to }),
    tx.conversation.updateMany({ where: moved, data: to }),
    tx.contactNote.updateMany({ where: moved, data: to }),
    tx.supervisionEvent.updateMany({ where: moved, data: to }),
    tx.contactPhone.updateMany({ where: moved, data: to }),
    tx.ticket.updateMany({ where: moved, data: to }),
  ]);

  // Campanhas: uma por contacto; se ambos estavam na mesma, fica a do que fica.
  const keepCampaigns = (await tx.campaignContact.findMany({ where: { contactId: keepId }, select: { campaignId: true } })).map((c) => c.campaignId);
  await tx.campaignContact.deleteMany({ where: { contactId: dropId, campaignId: { in: keepCampaigns } } });
  const campaigns = await tx.campaignContact.updateMany({ where: { contactId: dropId }, data: to });

  const keepPhone = keep.phone ? (normalizeAoPhone(keep.phone) ?? keep.phone) : null;
  const dropPhone = drop.phone ? (normalizeAoPhone(drop.phone) ?? drop.phone) : null;

  await tx.contact.delete({ where: { id: dropId } }); // liberta email/telegram/número únicos

  if (dropPhone && dropPhone !== keepPhone) {
    if (!keepPhone) {
      await tx.contact.update({ where: { id: keepId }, data: { phone: dropPhone } });
    } else {
      const already = await tx.contactPhone.findFirst({ where: { tenantId, phone: dropPhone }, select: { id: true } });
      if (!already) await tx.contactPhone.create({ data: { tenantId, contactId: keepId, phone: dropPhone, label: "Unido" } });
    }
  }
  const keepAttrs = (keep.attributes as Record<string, unknown> | null) ?? {};
  const dropAttrs = (drop.attributes as Record<string, unknown> | null) ?? {};
  await tx.contact.update({
    where: { id: keepId },
    data: {
      ...(!keep.name && drop.name && { name: drop.name }),
      ...(!keep.email && drop.email && { email: drop.email }),
      ...(!keep.telegramId && drop.telegramId && { telegramId: drop.telegramId }),
      ...(Object.keys(dropAttrs).length > 0 && { attributes: { ...dropAttrs, ...keepAttrs } as Prisma.InputJsonValue }),
      ...(!keep.optedOutAt && drop.optedOutAt && { optedOutAt: drop.optedOutAt, optOutReason: drop.optOutReason }),
    },
  });

  return {
    dropped: drop,
    moved: {
      calls: calls.count,
      sms: sms.count,
      conversations: conversations.count,
      notes: notes.count,
      supervision: supervision.count,
      phones: phones.count,
      tickets: tickets.count,
      campaigns: campaigns.count,
    },
  };
}

export class MergeError extends Error {}
