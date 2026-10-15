/**
 * Árvore da tipificação: categoria + até 3 níveis de subcategoria (o mesmo
 * limite da API, MAX_CATEGORY_DEPTH em callTyping.service.ts).
 */
export const MAX_CATEGORY_DEPTH = 4;

interface Node { id: string; parentId: string | null; name: string }

/** Caminho completo: "Faturação › Atraso › Multa". */
export function categoryPathLabel(cats: Node[], id: string): string {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const names: string[] = [];
  for (let cur = byId.get(id); cur && names.length < MAX_CATEGORY_DEPTH; cur = cur.parentId ? byId.get(cur.parentId) : undefined) names.unshift(cur.name);
  return names.join(' › ');
}

/** Ids do topo até ao nó (inclusive). */
export function categoryChain(cats: Node[], id: string | null): string[] {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out: string[] = [];
  for (let cur = id ? byId.get(id) : undefined; cur && out.length < MAX_CATEGORY_DEPTH; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.unshift(cur.id);
  return out;
}
