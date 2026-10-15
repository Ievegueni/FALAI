import { prisma } from "@falai/db";

/**
 * Encaminhamento de chamadas do módulo PBX nativo (docs/sip_trunk.md §2).
 * Substitui gradualmente o `outboundExtension.service` (baseado em TenantLine):
 * a fonte de verdade passa a ser `Extension`, com fallback para TenantLine
 * enquanto a migração (§6) não estiver concluída.
 */

/** Resolve a extensão de saída de um tenant a partir do modelo Extension. */
export async function resolveOutboundFromExtensions(tenantId: string): Promise<string | null> {
  const ext =
    (await prisma.extension.findFirst({
      where: { tenantId, isActive: true, isDefault: true },
      select: { number: true },
    })) ??
    (await prisma.extension.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { number: "asc" },
      select: { number: true },
    }));
  return ext?.number ?? null;
}

/** Resolve o destino de uma chamada de entrada a partir do DID. */
export async function resolveInbound(
  tenantId: string,
  did: string,
): Promise<{ destType: string; destValue: string } | null> {
  // Correspondência exacta primeiro; depois padrão (prefixo) por ordem de criação.
  const exact = await prisma.inboundRoute.findFirst({
    where: { tenantId, didPattern: did },
    select: { destType: true, destValue: true },
  });
  if (exact) return exact;

  const routes = await prisma.inboundRoute.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { didPattern: true, destType: true, destValue: true },
  });
  const match = routes.find((r) => did.startsWith(r.didPattern));
  return match ? { destType: match.destType, destValue: match.destValue } : null;
}

/**
 * Forma canónica de um DID para comparar números de clientes diferentes:
 * só dígitos, sem "00" internacional e sem o indicativo de Angola quando vem
 * à frente de um número nacional de 9 dígitos.
 */
export function normalizeDid(did: string): string {
  let d = did.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("244")) d = d.slice(3);
  return d;
}

/** Um DID num trunk partilhado tem de ser um número completo, não um prefixo. */
export function isFullDid(did: string): boolean {
  return /^\+?[0-9]{6,15}$/.test(did.trim());
}

/**
 * Igual a `resolveInbound`, mas sem tenant conhecido à partida — é o caso de
 * uma chamada a chegar do trunk partilhado (router ARI/Stasis de entrada): só
 * se sabe o DID, o tenant é o que a rota disser. Devolve também o tenantId,
 * para quem chama poder ir buscar a Extension certa.
 *
 * Só considera rotas de trunks partilhados e só por número exacto. Antes
 * procurava em todas as rotas e aceitava prefixos: um cliente que criasse uma
 * rota "9" no trunk partilhado ficava com as chamadas de entrada dos outros.
 * Se o mesmo número aparecer em mais de um cliente, não se entrega a nenhum.
 */
export async function resolveInboundGlobal(
  did: string,
): Promise<{ tenantId: string; destType: string; destValue: string } | null> {
  const wanted = normalizeDid(did);
  if (!wanted) return null;

  const routes = await prisma.inboundRoute.findMany({
    where: { trunk: { tenantId: null } },
    orderBy: { createdAt: "asc" },
    select: { tenantId: true, didPattern: true, destType: true, destValue: true },
  });
  const matches = routes.filter((r) => normalizeDid(r.didPattern) === wanted);
  if (matches.length === 0) return null;
  if (new Set(matches.map((m) => m.tenantId)).size > 1) return null;

  const m = matches[0]!;
  return { tenantId: m.tenantId, destType: m.destType, destValue: m.destValue };
}

/**
 * Num trunk partilhado, o número tem de ser completo e de um só cliente.
 * Devolve o motivo da recusa, ou null se a rota pode ser gravada.
 */
export async function sharedTrunkDidProblem(
  tenantId: string,
  trunkId: string,
  didPattern: string,
  ignoreRouteId?: string,
): Promise<string | null> {
  const trunk = await prisma.trunk.findUnique({ where: { id: trunkId }, select: { tenantId: true } });
  if (!trunk || trunk.tenantId !== null) return null; // trunk próprio: a numeração é do cliente

  if (!isFullDid(didPattern)) {
    return "Num trunk partilhado indica o número completo (só dígitos), não um prefixo.";
  }
  const wanted = normalizeDid(didPattern);
  const others = await prisma.inboundRoute.findMany({
    where: {
      tenantId: { not: tenantId },
      trunk: { tenantId: null },
      ...(ignoreRouteId && { id: { not: ignoreRouteId } }),
    },
    select: { didPattern: true },
  });
  if (others.some((r) => normalizeDid(r.didPattern) === wanted)) {
    return "Este número já está atribuído a outro cliente. Fala com a Comunica.";
  }
  return null;
}

/**
 * Rota de entrada de um tenant conhecido à partida — o caso do peering por IP,
 * em que o cliente se identifica pelo trunk por onde a chamada entrou.
 *
 * Ao contrário de `resolveInboundGlobal`, nunca sai deste tenant: numa
 * numeração interna o mesmo DID existe em vários clientes, e procurar em toda
 * a plataforma faria a chamada de um tocar na extensão de outro.
 *
 * Devolve a rota, ou — se o cliente não tiver rota nenhuma para este número mas
 * tiver uma extensão com esse número — a própria extensão. Num peering é isso
 * que o cliente espera: ele marca a extensão dele e ela toca, sem ter de
 * declarar uma rota de entrada por cada número interno.
 */
export async function resolveInboundForTenant(
  tenantId: string,
  did: string,
): Promise<{ tenantId: string; destType: string; destValue: string } | null> {
  const route = await resolveInbound(tenantId, did);
  if (route) return { tenantId, ...route };

  const ext = await prisma.extension.findFirst({
    where: { tenantId, number: did, isActive: true },
    select: { number: true },
  });
  return ext ? { tenantId, destType: "EXTENSION", destValue: ext.number } : null;
}
