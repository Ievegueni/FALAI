/**
 * Liga as chamadas de entrada antigas ao contacto do número de origem
 * (melhoria 3 — histórico do cliente). Até aqui o router de entrada do
 * Asterisk não preenchia Call.contactId, por isso essas chamadas não aparecem
 * no histórico do cliente. Só preenche onde está vazio; nunca troca um contacto.
 *
 * Correr DEPOIS de normalizar-telefones-legado.mts. Dry-run por defeito;
 * aplica com --apply.
 */
import { prisma } from "@falai/db";
import { findContactIdForCaller } from "../src/services/callerLookup.service.js";

const apply = process.argv.includes("--apply");

const calls = await prisma.call.findMany({
  where: { kind: "INBOUND", contactId: null, fromNumber: { not: null } },
  select: { id: true, tenantId: true, fromNumber: true },
});

let ligadas = 0;
for (const c of calls) {
  const contactId = await findContactIdForCaller(c.tenantId, c.fromNumber);
  if (!contactId) continue;
  ligadas++;
  if (apply) await prisma.call.updateMany({ where: { id: c.id, contactId: null }, data: { contactId } });
}

console.log(`chamadas de entrada sem contacto: ${calls.length}`);
console.log(`  com contacto encontrado       : ${ligadas}${apply ? " (ligadas)" : ""}`);
if (!apply) console.log("\n[dry-run] nada alterado. Repete com --apply.");
await prisma.$disconnect();
