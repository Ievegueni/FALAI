/**
 * Seed do módulo PBX nativo (Extensões/Trunk) — ver docs/sip_trunk.md §7.
 *
 * Semeia a config real do trunk de Angola + extensões 1000–1004 + grupos + roles
 * + rotas de saída, para validar/arrancar o módulo. Idempotente (upsert).
 *
 * Uso (a partir de packages/db, com DB a correr):
 *   pnpm seed:pbx                 # usa o primeiro tenant
 *   TENANT_ID=<cuid> pnpm seed:pbx
 *
 * Requer ENCRYPTION_KEY no ambiente (mesma chave da API) para encriptar os
 * segredos SIP no mesmo formato que o crypto.service consegue decifrar.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ---- Encriptação idêntica a apps/api/src/services/crypto.service.ts ----
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const rawStr = process.env["ENCRYPTION_KEY"];
  if (!rawStr) {
    throw new Error(
      "ENCRYPTION_KEY em falta. Corre com a mesma chave da API, ex.:\n" +
        "  ENCRYPTION_KEY=<chave> TENANT_ID=<cuid> pnpm seed:pbx",
    );
  }
  const raw = Buffer.from(rawStr, "utf8");
  return raw.length === 32 ? raw : createHash("sha256").update(raw).digest();
}

function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

// Gera "Nome de registo" SIP (estilo Yeastar, ex. "7jyXTI2S56")
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randomToken(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

// ---- Dados de referência (docs/sip_trunk.md §7) ----
const ROLES = [
  "Administrator",
  "Supervisor",
  "Operator",
  "Employee",
  "Human Resource",
  "Accounting",
  "Hotel Manager",
] as const;

function rolePermissions(name: string) {
  const admin = name === "Administrator";
  const supervisor = name === "Supervisor";
  return {
    extensionAndTrunk: {
      manageExtensions: admin ? "ALL" : supervisor ? "SAME_GROUP" : "SELF",
      linkusClients: true,
      groups: admin,
      clientPermission: admin,
      trunks: false,
      roles: false,
    },
    contacts: { company: true, phonebooks: true, ldap: admin },
    callControl: {
      inboundRoute: admin,
      outboundRoute: admin,
      autoclip: false,
      businessHours: admin || supervisor,
      emergencyNumber: true,
    },
    callFeatures: {
      voicemail: true,
      featureCode: true,
      ivr: admin,
      ringGroup: admin || supervisor,
      queue: admin || supervisor,
      conference: admin,
      speedDial: true,
      paging: admin,
    },
    ai: { receptionist: admin, toolbox: admin },
    messaging: { channel: true, queue: true, campaign: admin || supervisor },
    system: { dateTime: true, email: admin, storage: admin },
    reports: { cdr: true, recordings: admin || supervisor, callReports: true, externalChatLogs: admin },
    integration: admin,
    security: false,
    maintenance: false,
  };
}

const EXTENSIONS = [
  { number: "1000", role: "Administrator", email: "juvenal.dias1539.com@gmail.com", mobile: null },
  { number: "1001", role: "Supervisor", email: "ludmilabuanga@gmail.com", mobile: null },
  { number: "1002", role: "Operator", email: null, mobile: null },
  { number: "1003", role: "Operator", email: null, mobile: null },
  { number: "1004", role: "Administrator", email: "zaptelpipa@gmail.com", mobile: "933400967" },
] as const;

// Defaults por extensão (dos ecrãs do Yeastar)
const EXT_DEFAULTS = {
  presence: {
    forwarding: {
      internal: { noAnswer: "VOICEMAIL", busy: "VOICEMAIL" },
      external: { noAnswer: "VOICEMAIL", busy: "VOICEMAIL" },
    },
    ringStrategy: { first: ["endpoint", "linkusMobile", "linkusDesktop", "linkusWeb"] },
    ringTimeoutS: 30,
  },
  voicemail: { enabled: true, pinAuth: true, emailNotify: false },
  features: { recording: "NONE", moh: "SYSTEM", businessHours: { tz: "WAT" }, monitored: true },
  voip: { dtmf: "RFC4733", transport: ["UDP", "TCP"], qualify: true, t38: false, srtp: false },
  security: { disallowIntl: true, ipRestriction: false, sipAgentAuth: false },
};

const GROUPS: { name: string; isDefault: boolean; members: string[] }[] = [
  { name: "Default_All_Extensions", isDefault: true, members: ["1000", "1001", "1002", "1003", "1004"] },
  { name: "VENDAS", isDefault: false, members: ["1000"] },
  { name: "SUPORTE", isDefault: false, members: ["1001", "1002", "1003"] },
  { name: "FACTURACAO", isDefault: false, members: ["1004", "1000"] },
  { name: "FACTPLUS KITADIPLUS", isDefault: false, members: ["1004"] },
];

const OUTBOUND_ROUTES = ["Default_Outbound_Route", "SHARE_AGV_OUT", "To_S50"];

async function main() {
  const tenantId = process.env["TENANT_ID"];
  const tenant = tenantId
    ? await prisma.tenant.findUnique({ where: { id: tenantId } })
    : await prisma.tenant.findFirst({ orderBy: { createdAt: "asc" } });
  if (!tenant) throw new Error("Nenhum tenant encontrado. Cria um tenant antes de correr o seed.");
  console.log(`→ Seed PBX para tenant ${tenant.name} (${tenant.id})`);

  // 1) Roles
  const roleByName = new Map<string, string>();
  for (const name of ROLES) {
    const role = await prisma.role.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name } },
      update: { permissions: rolePermissions(name) },
      create: { tenantId: tenant.id, name, permissions: rolePermissions(name) },
    });
    roleByName.set(name, role.id);
  }
  console.log(`  ✓ ${ROLES.length} roles`);

  // 2) Trunk partilhado do operador (tenantId = null) — dados do provider
  let trunk = await prisma.trunk.findFirst({ where: { name: "TESTE.ANGOLA.AGV", tenantId: null } });
  const trunkData = {
    name: "TESTE.ANGOLA.AGV",
    tenantId: null,
    enabled: true,
    itspTemplate: "GENERIC",
    type: "REGISTER" as const,
    transport: "UDP" as const,
    host: "87.238.224.117",
    port: 5060,
    domain: "87.238.224.117",
    authUser: "878029113001",
    authName: "878029113001",
    authSecret: encryptSecret(process.env["TRUNK_SECRET"] ?? "CHANGE_ME_PROVIDER_SECRET"),
    codecs: ["ulaw", "alaw", "g729", "g726", "g722", "gsm"],
    dtmfMode: "RFC4733",
    dtmfFmtp: "0-16",
    authErrorCodes: "401;407;403",
    authRegAttempts: 3,
    regRetryIntervalS: 20,
    callRestriction: "OUTBOUND",
    maxConcurrent: null,
    voipFlags: { qualify: false, srtp: false, t38: false, inbandProgress: false },
  };
  trunk = trunk
    ? await prisma.trunk.update({ where: { id: trunk.id }, data: trunkData })
    : await prisma.trunk.create({ data: trunkData });
  await prisma.trunkDid.upsert({
    where: { trunkId_did: { trunkId: trunk.id, did: "244959100354" } },
    update: {},
    create: { trunkId: trunk.id, did: "244959100354" },
  });
  console.log(`  ✓ trunk TESTE.ANGOLA.AGV + DID 244959100354`);

  // 3) Extensões 1000–1004
  const extByNumber = new Map<string, string>();
  for (const e of EXTENSIONS) {
    const existing = await prisma.extension.findUnique({
      where: { tenantId_number: { tenantId: tenant.id, number: e.number } },
    });
    const base = {
      callerId: e.number,
      displayName: e.number,
      email: e.email,
      mobile: e.mobile,
      roleId: roleByName.get(e.role) ?? null,
      isDefault: e.number === "1000",
      ...EXT_DEFAULTS,
    };
    const ext = existing
      ? await prisma.extension.update({ where: { id: existing.id }, data: base })
      : await prisma.extension.create({
          data: {
            tenantId: tenant.id,
            number: e.number,
            sipAuthUser: randomToken(10),
            sipAuthSecret: encryptSecret(randomToken(24)),
            ...base,
          },
        });
    extByNumber.set(e.number, ext.id);
  }
  console.log(`  ✓ ${EXTENSIONS.length} extensões`);

  // 4) Grupos + membros
  for (const g of GROUPS) {
    const group = await prisma.extensionGroup.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: g.name } },
      update: { isDefault: g.isDefault },
      create: { tenantId: tenant.id, name: g.name, isDefault: g.isDefault },
    });
    for (const num of g.members) {
      const extId = extByNumber.get(num);
      if (!extId) continue;
      await prisma.extensionGroupMember.upsert({
        where: { extensionId_groupId: { extensionId: extId, groupId: group.id } },
        update: {},
        create: { extensionId: extId, groupId: group.id },
      });
    }
  }
  console.log(`  ✓ ${GROUPS.length} grupos`);

  // 5) Rotas de saída → trunk, com todas as extensões permitidas
  for (const [i, name] of OUTBOUND_ROUTES.entries()) {
    const route = await prisma.outboundRoute.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name } },
      update: { trunkId: trunk.id, priority: i },
      create: { tenantId: tenant.id, name, trunkId: trunk.id, priority: i },
    });
    for (const extId of extByNumber.values()) {
      await prisma.outboundRoutePermission.upsert({
        where: { routeId_extensionId: { routeId: route.id, extensionId: extId } },
        update: {},
        create: { routeId: route.id, extensionId: extId },
      });
    }
  }
  console.log(`  ✓ ${OUTBOUND_ROUTES.length} rotas de saída`);

  console.log("✅ Seed PBX concluído.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
