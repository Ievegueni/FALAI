/**
 * Migração de dados: TenantLine → Extension (docs/sip_trunk.md §6).
 *
 * Para cada TenantLine cria uma Extension equivalente (se ainda não existir uma
 * com o mesmo número no tenant), gerando credenciais SIP e aplicando os defaults.
 * NÃO apaga TenantLine (fica deprecado 1 release). Idempotente.
 *
 * Uso (a partir de packages/db, com DB a correr e ENCRYPTION_KEY definido):
 *   ENCRYPTION_KEY=<chave> pnpm exec tsx prisma/migrate-tenantline-to-extension.ts
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ALGORITHM = "aes-256-gcm";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function getKey(): Buffer {
  const rawStr = process.env["ENCRYPTION_KEY"];
  if (!rawStr) throw new Error("ENCRYPTION_KEY em falta (usa a mesma chave da API).");
  const raw = Buffer.from(rawStr, "utf8");
  return raw.length === 32 ? raw : createHash("sha256").update(raw).digest();
}
function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}
function token(len: number): string {
  const b = randomBytes(len);
  let o = "";
  for (let i = 0; i < len; i++) o += ALPHABET[b[i]! % ALPHABET.length];
  return o;
}

const DEFAULTS = {
  presence: { forwarding: { internal: { noAnswer: "VOICEMAIL", busy: "VOICEMAIL" }, external: { noAnswer: "VOICEMAIL", busy: "VOICEMAIL" } }, ringStrategy: { first: ["endpoint", "linkusMobile", "linkusDesktop", "linkusWeb"] }, ringTimeoutS: 30 },
  voicemail: { enabled: true, pinAuth: true, emailNotify: false },
  features: { recording: "NONE", moh: "SYSTEM", businessHours: { tz: "WAT" }, monitored: true },
  voip: { dtmf: "RFC4733", transport: ["UDP", "TCP"], qualify: true, t38: false, srtp: false },
  security: { disallowIntl: true, ipRestriction: false, sipAgentAuth: false },
};

async function main() {
  const lines = await prisma.tenantLine.findMany({ orderBy: { createdAt: "asc" } });
  console.log(`→ ${lines.length} TenantLine(s) a migrar`);
  let created = 0;
  let skipped = 0;

  for (const line of lines) {
    const exists = await prisma.extension.findUnique({
      where: { tenantId_number: { tenantId: line.tenantId, number: line.extension } },
    });
    if (exists) { skipped++; continue; }

    await prisma.extension.create({
      data: {
        tenantId: line.tenantId,
        number: line.extension,
        callerId: line.extension,
        displayName: line.name,
        phoneNumber: line.phoneNumber,
        isDefault: line.isDefault,
        isActive: line.isActive,
        sipAuthUser: token(10),
        sipAuthSecret: encryptSecret(token(24)),
        ...DEFAULTS,
      },
    });
    created++;
  }

  console.log(`✅ Concluído: ${created} criadas, ${skipped} já existentes (ignoradas).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
