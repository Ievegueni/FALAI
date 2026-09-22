/**
 * Normaliza contactos gravados em formato antigo (+244…, 244…, 00244…) para o
 * formato canónico de 9 dígitos, que é o que a chave única (tenantId, phone)
 * e todas as rotas usam desde a unificação do normalizeAoPhone.
 *
 * Sem isto, um contacto legado é invisível à procura por número: o cliente
 * carrega a lista, o sistema não o encontra, cria um registo novo em 9 dígitos
 * e o histórico de chamadas fica órfão no registo antigo.
 *
 * Colisões (o número já existir também em 9 dígitos) são resolvidas por fusão:
 * o registo com histórico sobrevive, o outro é absorvido e apagado.
 *
 * Dry-run por defeito. Aplica com --apply.
 */
import { prisma } from "@falai/db";
import { normalizeAoPhone } from "@falai/shared";

const apply = process.argv.includes("--apply");

const legacy = await prisma.contact.findMany({
  where: { NOT: { phone: { startsWith: "9" } } },
  select: { id: true, tenantId: true, phone: true, name: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});
const suspects = legacy.filter((c) => !/^[0-9]{9}$/.test(c.phone));

const renomear: Array<{ id: string; de: string; para: string }> = [];
const fundir: Array<{ manter: string; absorver: string; phone: string; hist: number }> = [];
const semSolucao: Array<{ id: string; phone: string }> = [];

for (const c of suspects) {
  const nat = normalizeAoPhone(c.phone);
  if (!nat) { semSolucao.push({ id: c.id, phone: c.phone }); continue; }

  const twin = await prisma.contact.findUnique({
    where: { tenantId_phone: { tenantId: c.tenantId, phone: nat } },
    select: { id: true },
  });
  if (!twin) { renomear.push({ id: c.id, de: c.phone, para: nat }); continue; }

  const peso = async (id: string) =>
    (await prisma.campaignContact.count({ where: { contactId: id } })) +
    (await prisma.call.count({ where: { contactId: id } })) +
    (await prisma.smsMessage.count({ where: { contactId: id } }));
  const [pLegado, pNovo] = [await peso(c.id), await peso(twin.id)];
  // Sobrevive quem tem histórico; empate fica com o mais antigo (o legado).
  if (pLegado >= pNovo) fundir.push({ manter: c.id, absorver: twin.id, phone: nat, hist: pNovo });
  else fundir.push({ manter: twin.id, absorver: c.id, phone: nat, hist: pLegado });
}

console.log(`contactos em formato antigo : ${suspects.length}`);
console.log(`  a renomear para 9 dígitos : ${renomear.length}`);
console.log(`  a fundir (colisão)        : ${fundir.length}`);
console.log(`  sem solução (não angolano): ${semSolucao.length}`);
for (const f of fundir) console.log(`    ${f.phone}: mantém ${f.manter}, absorve ${f.absorver} (${f.hist} registos a mover)`);
for (const s of semSolucao) console.log(`    SEM SOLUÇÃO ${s.phone} (${s.id})`);
console.log(`\nexemplos de renomeação: ${renomear.slice(0, 3).map((r) => `${r.de} -> ${r.para}`).join(", ")}`);

if (!apply) { console.log("\n[dry-run] nada alterado. Repete com --apply."); await prisma.$disconnect(); process.exit(0); }

await prisma.$transaction(async (tx) => {
  for (const f of fundir) {
    await tx.campaignContact.deleteMany({
      where: { contactId: f.absorver, campaignId: { in: (await tx.campaignContact.findMany({ where: { contactId: f.manter }, select: { campaignId: true } })).map((x) => x.campaignId) } },
    });
    await tx.campaignContact.updateMany({ where: { contactId: f.absorver }, data: { contactId: f.manter } });
    await tx.call.updateMany({ where: { contactId: f.absorver }, data: { contactId: f.manter } });
    await tx.smsMessage.updateMany({ where: { contactId: f.absorver }, data: { contactId: f.manter } });
    await tx.contact.delete({ where: { id: f.absorver } });
  }
  for (const r of renomear) await tx.contact.update({ where: { id: r.id }, data: { phone: r.para } });
  for (const f of fundir) {
    const c = await tx.contact.findUnique({ where: { id: f.manter }, select: { phone: true } });
    if (c && c.phone !== f.phone) await tx.contact.update({ where: { id: f.manter }, data: { phone: f.phone } });
  }
}, { timeout: 120_000 });

const resto = (await prisma.contact.findMany({ select: { phone: true } })).filter((c) => !/^[0-9]{9}$/.test(c.phone));
console.log(`\naplicado. contactos ainda em formato antigo: ${resto.length}`);
await prisma.$disconnect();
