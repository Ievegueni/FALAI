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
 * Igual a `resolveInbound`, mas sem tenant conhecido à partida — é o caso de
 * uma chamada a chegar do trunk (router ARI/Stasis de entrada): só se sabe o
 * DID, o tenant é o que a rota disser. Devolve também o tenantId, para quem
 * chama poder ir buscar a Extension certa.
 */
export async function resolveInboundGlobal(
  did: string,
): Promise<{ tenantId: string; destType: string; destValue: string } | null> {
  const exact = await prisma.inboundRoute.findFirst({
    where: { didPattern: did },
    select: { tenantId: true, destType: true, destValue: true },
  });
  if (exact) return exact;

  const routes = await prisma.inboundRoute.findMany({
    orderBy: { createdAt: "asc" },
    select: { tenantId: true, didPattern: true, destType: true, destValue: true },
  });
  const match = routes.find((r) => did.startsWith(r.didPattern));
  return match ? { tenantId: match.tenantId, destType: match.destType, destValue: match.destValue } : null;
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
