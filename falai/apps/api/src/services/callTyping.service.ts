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

/** Níveis da árvore: categoria + até 3 níveis de subcategoria. */
export const MAX_CATEGORY_DEPTH = 4;

/** Nível de um nó (1 = categoria de topo). Pura. */
export function categoryDepth(all: Pick<CategoryNode, "id" | "parentId">[], id: string): number {
  const byId = new Map(all.map((c) => [c.id, c]));
  let d = 0;
  for (let cur = byId.get(id); cur && d <= MAX_CATEGORY_DEPTH + 1; cur = cur.parentId ? byId.get(cur.parentId) : undefined) d++;
  return d;
}

/**
 * Categorias que um agente pode usar: activas e sem restrição de grupo, ou
 * associadas a um dos grupos dele (ou ao grupo por onde a chamada tocou).
 * As subcategorias (todos os níveis) seguem a categoria; uma inactiva esconde
 * também as que estão por baixo dela.
 */
export function visibleCategories(all: CategoryNode[], groupIds: Set<string>): CategoryNode[] {
  const out = all.filter(
    (c) => c.parentId === null && c.isActive && (c.groupIds.length === 0 || c.groupIds.some((g) => groupIds.has(g)))
  );
  const seen = new Set(out.map((c) => c.id));
  for (let level = 1; level < MAX_CATEGORY_DEPTH; level++) {
    const next = all.filter((c) => c.parentId !== null && c.isActive && !seen.has(c.id) && seen.has(c.parentId));
    for (const c of next) seen.add(c.id);
    out.push(...next);
  }
  return out;
}

/**
 * Valida a escolha do agente contra as categorias que ele pode ver. Tem de
 * descer até ao fim: um nível com subcategorias activas exige escolher uma
 * delas. `subcategoryId` é o último nível escolhido (qualquer profundidade).
 * Devolve a mensagem de erro, ou null se estiver bem.
 */
export function validateTyping(
  visible: CategoryNode[],
  categoryId: string,
  subcategoryId: string | null
): string | null {
  const cat = visible.find((c) => c.id === categoryId && c.parentId === null);
  if (!cat) return "Categoria inválida";
  const hasChildren = (id: string) => visible.some((c) => c.parentId === id);
  if (subcategoryId === null) return hasChildren(categoryId) ? "Escolha a subcategoria" : null;
  const byId = new Map(visible.map((c) => [c.id, c]));
  let cur = byId.get(subcategoryId);
  if (!cur || cur.parentId === null) return "Subcategoria inválida";
  // Tem de estar por baixo da categoria escolhida.
  let top = cur;
  while (top.parentId !== null) {
    const up = byId.get(top.parentId);
    if (!up) return "Subcategoria inválida";
    top = up;
  }
  if (top.id !== categoryId) return "Subcategoria inválida";
  return hasChildren(cur.id) ? "Escolha a subcategoria" : null;
}

/**
 * Caminho de cada subcategoria abaixo da categoria de topo: "Sub › Sub-sub".
 * É o que os relatórios mostram na coluna "Subcategoria". Pura.
 */
export function subcategoryPaths(all: Pick<CategoryNode, "id" | "parentId" | "name">[]): Map<string, string> {
  const byId = new Map(all.map((c) => [c.id, c]));
  const out = new Map<string, string>();
  for (const c of all) {
    if (c.parentId === null) continue;
    const names: string[] = [];
    for (let cur: typeof c | undefined = c; cur && cur.parentId !== null && names.length <= MAX_CATEGORY_DEPTH; cur = byId.get(cur.parentId)) names.unshift(cur.name);
    out.set(c.id, names.join(" › "));
  }
  return out;
}

/** O nó e todos os seus antepassados (ids). Serve para filtrar por um nível do meio. Pura. */
export function categoryLineage(all: Pick<CategoryNode, "id" | "parentId">[], id: string | null): string[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: string[] = [];
  for (let cur = id ? byId.get(id) : undefined; cur && out.length <= MAX_CATEGORY_DEPTH; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.push(cur.id);
  return out;
}

/**
 * Filtro Prisma "tipificada nesta categoria ou em algo por baixo dela".
 * A perna guarda a categoria de topo e o último nível; os do meio chegam-se
 * pelos pais do último (profundidade fixa, MAX_CATEGORY_DEPTH).
 */
export function legUnderCategory(id: string) {
  return {
    OR: [
      { categoryId: id },
      { subcategoryId: id },
      { subcategory: { parentId: id } },
      { subcategory: { parent: { parentId: id } } },
    ],
  };
}

/**
 * `select` da subcategoria com os pais até ao topo (MAX_CATEGORY_DEPTH) — para
 * mostrar o caminho sem carregar a árvore toda. Usar com subPathName().
 */
export const SUB_PATH_SELECT = {
  name: true,
  parentId: true,
  parent: { select: { name: true, parentId: true, parent: { select: { name: true, parentId: true } } } },
} as const;

type SubNode = { name: string; parentId: string | null; parent?: SubNode | null };

/** "Sub › Sub-sub" a partir de um resultado com SUB_PATH_SELECT. Pura. */
export function subPathName(s: SubNode | null | undefined): string | null {
  if (!s) return null;
  const names: string[] = [];
  for (let cur: SubNode | null | undefined = s; cur && cur.parentId !== null; cur = cur.parent) names.unshift(cur.name);
  return names.join(" › ") || s.name;
}

/** Mapa id → "Sub › Sub-sub" das subcategorias do tenant. */
export async function loadSubcategoryPaths(tenantId: string): Promise<Map<string, string>> {
  return subcategoryPaths(await prisma.callCategory.findMany({ where: { tenantId }, select: { id: true, parentId: true, name: true } }));
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
