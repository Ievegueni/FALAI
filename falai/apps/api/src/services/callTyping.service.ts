/**
 * Tipificação de chamadas (melhoria 2/4). A tipificação fica na perna que
 * atendeu (CallLeg) — é ela que diz que agente e que grupo atenderam.
 *
 * Regras (ver SPRINTS.md):
 * - Obrigatória (Tenant.typingRequired): quando a chamada acaba, a perna ganha
 *   wrapUpEndsAt = fim + typingMaxSecs. Até lá a extensão não recebe chamadas
 *   novas (ver busyExtensionIds no router de entrada). Ao expirar, conta como
 *   "não tipificada" — o agente pode tipificar mais tarde na mesma.
 * - Opcional: sem prazo nem bloqueio; o que não for tipificado conta como
 *   "não tipificada" nos relatórios.
 * - O tempo em pós-chamada (wrap-up) é separado do TMA: o TMA acaba no fim da
 *   chamada (endedAt), o wrap-up vai do fim até à tipificação (ou ao prazo).
 */
import { prisma } from "@falai/db";

export type TypingStatus = "NONE" | "TYPED" | "PENDING" | "NOT_TYPED";

interface TypingLeg {
  outcome: string | null;
  endedAt: Date | null;
  typedAt: Date | null;
  wrapUpEndsAt: Date | null;
}

/** NONE = não há nada a tipificar (a perna não atendeu). */
export function typingStatus(leg: TypingLeg, now: Date): TypingStatus {
  if (leg.outcome !== "ANSWERED") return "NONE";
  if (leg.typedAt) return "TYPED";
  if (leg.wrapUpEndsAt && leg.wrapUpEndsAt > now) return "PENDING";
  return "NOT_TYPED";
}

/** Prazo para tipificar; null quando a tipificação é opcional. */
export function wrapUpDeadline(endedAt: Date, cfg: { typingRequired: boolean; typingMaxSecs: number }): Date | null {
  return cfg.typingRequired ? new Date(endedAt.getTime() + cfg.typingMaxSecs * 1000) : null;
}

/**
 * Segundos em pós-chamada. Com prazo, nunca passa do prazo (tipificar no dia
 * seguinte não pode inflacionar a média). Sem prazo, só conta se tipificou.
 * null = ainda a decorrer, ou nada a medir.
 */
export function wrapUpSecs(leg: TypingLeg, now: Date): number | null {
  if (leg.outcome !== "ANSWERED" || !leg.endedAt) return null;
  let end: Date | null = leg.typedAt;
  if (leg.wrapUpEndsAt) {
    if (end === null || end > leg.wrapUpEndsAt) end = leg.wrapUpEndsAt <= now ? leg.wrapUpEndsAt : null;
  }
  return end ? Math.max(0, Math.round((end.getTime() - leg.endedAt.getTime()) / 1000)) : null;
}

export interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  isActive: boolean;
  groupIds: string[];
}

/**
 * Categorias que um agente pode usar: activas e sem restrição de grupo, ou
 * associadas a um dos grupos dele (ou ao grupo por onde a chamada tocou).
 * As subcategorias seguem a categoria.
 */
export function visibleCategories(all: CategoryNode[], groupIds: Set<string>): CategoryNode[] {
  const tops = all.filter(
    (c) => c.parentId === null && c.isActive && (c.groupIds.length === 0 || c.groupIds.some((g) => groupIds.has(g)))
  );
  const topIds = new Set(tops.map((c) => c.id));
  return [...tops, ...all.filter((c) => c.parentId !== null && c.isActive && topIds.has(c.parentId))];
}

/**
 * Valida a escolha do agente contra as categorias que ele pode ver. Uma
 * categoria com subcategorias activas exige subcategoria. Devolve a mensagem
 * de erro, ou null se estiver bem.
 */
export function validateTyping(
  visible: CategoryNode[],
  categoryId: string,
  subcategoryId: string | null
): string | null {
  const cat = visible.find((c) => c.id === categoryId && c.parentId === null);
  if (!cat) return "Categoria inválida";
  const subs = visible.filter((c) => c.parentId === categoryId);
  if (subcategoryId === null) return subs.length > 0 ? "Escolha a subcategoria" : null;
  return subs.some((s) => s.id === subcategoryId) ? null : "Subcategoria inválida";
}

// ─── BD ──────────────────────────────────────────────────────────────────────

/** Extensões ainda dentro do prazo de tipificação — não recebem chamadas novas. */
export async function busyExtensionIds(extensionIds: string[], now = new Date()): Promise<Set<string>> {
  if (extensionIds.length === 0) return new Set();
  const rows = await prisma.callLeg.findMany({
    where: { extensionId: { in: extensionIds }, typedAt: null, wrapUpEndsAt: { gt: now } },
    select: { extensionId: true },
  });
  return new Set(rows.map((r) => r.extensionId!));
}

/** Categorias do tenant com os grupos de cada uma. */
export async function loadCategories(tenantId: string): Promise<(CategoryNode & { sortOrder: number })[]> {
  const rows = await prisma.callCategory.findMany({
    where: { tenantId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, parentId: true, name: true, isActive: true, sortOrder: true, groups: { select: { groupId: true } } },
  });
  return rows.map(({ groups, ...c }) => ({ ...c, groupIds: groups.map((g) => g.groupId) }));
}

/** Grupos que contam para a visibilidade de uma perna: os da extensão + o da chamada. */
export async function legGroupIds(leg: { extensionId: string | null; groupId: string | null }): Promise<Set<string>> {
  const ids = new Set<string>(leg.groupId ? [leg.groupId] : []);
  if (leg.extensionId) {
    const m = await prisma.extensionGroupMember.findMany({ where: { extensionId: leg.extensionId }, select: { groupId: true } });
    for (const g of m) ids.add(g.groupId);
  }
  return ids;
}
