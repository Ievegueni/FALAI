/**
 * Histórico do cliente na entrada da chamada (melhoria 3/4 — "screen pop").
 *
 * Identifica o cliente pelo número de origem e junta, numa só resposta, os
 * dados do contacto, as últimas chamadas (com agente, grupo, estado e a
 * tipificação da melhoria 2), os destaques e o resto que o CRM já guarda.
 *
 * Números: o formato de gravação do projecto é o NACIONAL de 9 dígitos (ver
 * packages/shared/src/phone.ts — decisão contra os duplicados). Para o ecrã
 * usa-se "+244 9XX XXX XXX". A pesquisa aceita também o formato legado
 * "+244…"/"244…" ainda presente em contactos antigos, até correr o script
 * scripts/normalizar-telefones-legado.mts.
 */
import { prisma, type Prisma } from "@falai/db";
import { normalizeAoPhone } from "@falai/shared";

// ─── Funções puras ───────────────────────────────────────────────────────────

/** Valores que operadoras/PBX usam para "número oculto". */
const HIDDEN = new Set(["", "anonymous", "unknown", "restricted", "private", "unavailable", "withheld"]);

export type Caller =
  | { kind: "HIDDEN" }
  | { kind: "NUMBER"; raw: string; national: string | null; display: string };

/**
 * Classifica o número de origem. Oculto → não se pesquisa. Um número angolano
 * reconhecível fica com o nacional (para pesquisar) e o E.164 (para mostrar);
 * qualquer outro (internacional, interno) mostra-se tal como chegou.
 */
export function classifyCaller(raw: string | null | undefined): Caller {
  const v = (raw ?? "").trim();
  if (HIDDEN.has(v.toLowerCase())) return { kind: "HIDDEN" };
  // Só pontuação/zeros ("0", "+", "000") também é número oculto.
  if (!/[1-9]/.test(v)) return { kind: "HIDDEN" };
  const national = normalizeAoPhone(v);
  return { kind: "NUMBER", raw: v, national, display: national ? displayPhone(national) : v };
}

/** "923456789" → "+244 923 456 789". */
export function displayPhone(national: string): string {
  return `+244 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** Formas em que o mesmo número pode estar gravado (canónico + legado). */
export function phoneVariants(national: string): string[] {
  return [national, `+244${national}`, `244${national}`];
}

export type HistoryState = "ANSWERED" | "MISSED" | "REJECTED" | "IN_PROGRESS";

/**
 * Estado de uma chamada no histórico do cliente. Recusada = nenhuma
 * extensão atendeu e pelo menos uma recusou (melhoria 1).
 */
export function historyState(c: { answeredAt: Date | null; endedAt: Date | null; legOutcomes: (string | null)[] }): HistoryState {
  if (c.answeredAt) return c.endedAt ? "ANSWERED" : "IN_PROGRESS";
  if (!c.endedAt) return "IN_PROGRESS";
  return c.legOutcomes.includes("REJECTED") ? "REJECTED" : "MISSED";
}

// ─── BD ──────────────────────────────────────────────────────────────────────

/** Contacto dono deste número (principal ou extra). Consultas por índice único. */
export async function findContactIdByNational(tenantId: string, national: string): Promise<string | null> {
  const variants = phoneVariants(national);
  const c = await prisma.contact.findFirst({
    where: { tenantId, OR: [{ phone: { in: variants } }, { phones: { some: { phone: { in: variants } } } }] },
    select: { id: true },
  });
  return c?.id ?? null;
}

/** Contacto pelo número em bruto (o que chega do trunk/PBX). Oculto → null. */
export async function findContactIdForCaller(tenantId: string, raw: string | null | undefined): Promise<string | null> {
  const caller = classifyCaller(raw);
  if (caller.kind !== "NUMBER" || !caller.national) return null;
  return findContactIdByNational(tenantId, caller.national);
}

/** O número já pertence a algum contacto do tenant (principal ou extra)? */
export async function phoneOwner(tenantId: string, national: string): Promise<string | null> {
  return findContactIdByNational(tenantId, national);
}

const historySelect = {
  id: true,
  kind: true,
  startedAt: true,
  answeredAt: true,
  endedAt: true,
  durationSecs: true,
  status: true,
  group: { select: { name: true } },
  legs: {
    select: {
      extensionNumber: true,
      outcome: true,
      typingNote: true,
      typedAt: true,
      extension: { select: { displayName: true } },
      category: { select: { name: true } },
      subcategory: { select: { name: true } },
    },
  },
} satisfies Prisma.CallSelect;

type HistoryCall = Prisma.CallGetPayload<{ select: typeof historySelect }>;

function mapHistory(c: HistoryCall) {
  const answered = c.legs.find((l) => l.outcome === "ANSWERED");
  return {
    id: c.id,
    kind: c.kind,
    at: c.startedAt,
    agent: answered ? (answered.extension?.displayName ?? answered.extensionNumber) : null,
    group: c.group?.name ?? null,
    durationSecs:
      c.answeredAt && c.endedAt ? Math.round((c.endedAt.getTime() - c.answeredAt.getTime()) / 1000) : c.durationSecs,
    // Chamadas de saída (campanhas, click-to-call) não têm pernas: o estado vem do status.
    state:
      c.kind === "INBOUND"
        ? historyState({ answeredAt: c.answeredAt, endedAt: c.endedAt, legOutcomes: c.legs.map((l) => l.outcome) })
        : c.status,
    typing: answered?.category ? [answered.category.name, answered.subcategory?.name].filter(Boolean).join(" › ") : null,
    note: answered?.typingNote ?? null,
  };
}

/** Chamadas do contacto, mais recentes primeiro. `before` pagina ("ver mais"). */
export async function contactHistory(tenantId: string, contactId: string, limit: number, before?: Date) {
  const rows = await prisma.call.findMany({
    where: { tenantId, contactId, ...(before && { startedAt: { lt: before } }) },
    orderBy: { startedAt: "desc" },
    take: limit + 1,
    select: historySelect,
  });
  return { data: rows.slice(0, limit).map(mapHistory), hasMore: rows.length > limit };
}

/** Painel completo: contacto, histórico (10), destaques e dados do CRM. */
export async function buildCallerPanel(tenantId: string, raw: string | null | undefined) {
  const caller = classifyCaller(raw);
  if (caller.kind === "HIDDEN") return { caller, contact: null };
  const contactId = caller.national ? await findContactIdByNational(tenantId, caller.national) : null;
  if (!contactId) return { caller, contact: null };

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [contact, history, last7Days, lastTyped, conversations, notes] = await Promise.all([
    prisma.contact.findFirstOrThrow({
      where: { id: contactId, tenantId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        attributes: true,
        optedOutAt: true,
        createdAt: true,
        phones: { select: { id: true, phone: true, label: true }, orderBy: { createdAt: "asc" } },
      },
    }),
    contactHistory(tenantId, contactId, 10),
    prisma.call.count({ where: { tenantId, contactId, startedAt: { gte: weekAgo } } }),
    prisma.callLeg.findFirst({
      where: { tenantId, call: { contactId }, typedAt: { not: null } },
      orderBy: { typedAt: "desc" },
      select: { typedAt: true, typingNote: true, category: { select: { name: true } }, subcategory: { select: { name: true } } },
    }),
    prisma.conversation.findMany({
      where: { tenantId, contactId },
      orderBy: { lastMessageAt: "desc" },
      take: 3,
      select: { id: true, status: true, lastMessageAt: true, inbox: { select: { channel: true, name: true } } },
    }),
    prisma.contactNote.findMany({
      where: { tenantId, contactId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, body: true, createdAt: true, authorId: true, callId: true },
    }),
  ]);

  return {
    caller,
    contact: {
      ...contact,
      phone: contact.phone ? (normalizeAoPhone(contact.phone) ?? contact.phone) : null,
    },
    history,
    highlights: {
      callsLast7Days: last7Days,
      lastTyping: lastTyped?.category
        ? {
            label: [lastTyped.category.name, lastTyped.subcategory?.name].filter(Boolean).join(" › "),
            at: lastTyped.typedAt,
            note: lastTyped.typingNote,
          }
        : null,
    },
    conversations,
    notes: await withAuthors(notes),
  };
}

/** Junta o nome de quem escreveu a nota (TenantUser). */
async function withAuthors<T extends { authorId: string }>(notes: T[]): Promise<(T & { author: string | null })[]> {
  const ids = [...new Set(notes.map((n) => n.authorId))];
  const users = ids.length
    ? await prisma.tenantUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const name = new Map(users.map((u) => [u.id, u.name]));
  return notes.map((n) => ({ ...n, author: name.get(n.authorId) ?? null }));
}
