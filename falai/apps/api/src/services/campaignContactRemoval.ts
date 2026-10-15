/**
 * Que contactos podem sair de uma campanha pela API v1.
 *
 * Antes só saíam os que ainda não tinham sido tentados (PENDING/QUEUED/OPTED_OUT).
 * Os clientes usam a remoção quando o caso passa para outra equipa ou outra
 * campanha, e aí um contacto já FAILED ou COMPLETED também tem de sair: senão
 * continua na lista, um `/retry` da campanha volta a pô-lo em PENDING, e quem
 * confirma a remoção pela listagem fica preso a repetir o pedido. O histórico
 * não se perde, as chamadas guardam o seu próprio `campaignId`.
 *
 * Só fica de fora o IN_PROGRESS: há uma chamada a decorrer e o fecho dela ainda
 * vai escrever neste registo. O cliente volta a pedir quando a chamada acabar.
 */
export const NON_REMOVABLE_STATUSES = ["IN_PROGRESS"] as const;

export type RemovalSkipReason = "IN_PROGRESS" | "NOT_IN_CAMPAIGN";

export interface RemovalCandidate {
  id: string;
  contactId: string;
  status: string;
}

export function isRemovable(status: string): boolean {
  return !NON_REMOVABLE_STATUSES.includes(status as (typeof NON_REMOVABLE_STATUSES)[number]);
}

export function planRemoval(requestedIds: string[], candidates: RemovalCandidate[]) {
  const byContact = new Map(candidates.map((c) => [c.contactId, c]));
  const removable: RemovalCandidate[] = [];
  const skipped: { contactId: string; reason: RemovalSkipReason }[] = [];

  for (const contactId of new Set(requestedIds)) {
    const c = byContact.get(contactId);
    if (!c) skipped.push({ contactId, reason: "NOT_IN_CAMPAIGN" });
    else if (!isRemovable(c.status)) skipped.push({ contactId, reason: "IN_PROGRESS" });
    else removable.push(c);
  }

  return { removable, skipped };
}
