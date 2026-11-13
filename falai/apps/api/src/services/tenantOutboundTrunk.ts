// Por que tronco sai uma chamada de um cliente.
//
// Regra (2026-11-13, ANGOVOIP): um cliente com tronco PRÓPRIO de registo
// (type REGISTER, tenantId = ele) sai SÓ por esse tronco. Se estiver
// desligado, não sai — nunca cai no partilhado (COMUNICA), que tem outro
// número e as linhas de outros clientes. Clientes sem tronco próprio de
// registo (ex.: só um PEER de entrada, como a FÁCIL CRÉDITO) saem pelo
// partilhado, como sempre.

export interface OutboundTrunkCandidate {
  tenantId: string | null;
  name: string;
  enabled: boolean;
  type: string;
  authUser: string | null;
}

export type OutboundTrunkChoice<T extends OutboundTrunkCandidate> =
  | { kind: "own"; trunk: T }
  | { kind: "own_disabled" }
  | { kind: "shared"; trunk: T | null };

/** `trunks` deve vir já ordenado (o primeiro elegível ganha). */
export function pickOutboundTrunk<T extends OutboundTrunkCandidate>(
  tenantId: string | null | undefined,
  trunks: readonly T[],
): OutboundTrunkChoice<T> {
  if (tenantId) {
    const own = trunks.filter((t) => t.tenantId === tenantId && t.type === "REGISTER");
    if (own.length > 0) {
      const enabled = own.find((t) => t.enabled);
      return enabled ? { kind: "own", trunk: enabled } : { kind: "own_disabled" };
    }
  }
  return { kind: "shared", trunk: sharedOutboundTrunk(trunks) };
}

/** Primeiro tronco partilhado (tenantId nulo) ativo: a saída por omissão. */
export function sharedOutboundTrunk<T extends OutboundTrunkCandidate>(trunks: readonly T[]): T | null {
  return trunks.find((t) => t.tenantId === null && t.enabled) ?? null;
}
