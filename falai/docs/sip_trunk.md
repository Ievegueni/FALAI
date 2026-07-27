# Módulo nativo "Extensões e Trunk" — Spec de implementação

> **Objetivo:** tornar o Falaí **igual ao Yeastar P-Series** na parte de *Extensão e trunk* —
> um módulo próprio onde o cliente configura **extensões, trunk SIP, grupos, funções (roles) e
> encaminhamento** diretamente no Falaí, sem depender da consola do PBX.
>
> **O que NÃO é:** não é integração/proxy à OpenAPI da Yeastar. O Falaí passa a ser dono da
> configuração.
>
> **O que recebemos do provider:** apenas os dados de ligação SIP para as chamadas saírem/entrarem
> — **host/IP, porta, transporte, utilizador/segredo de registo e o(s) DID(s)**. Tudo o resto
> (extensões, grupos, roles, rotas, presença, voicemail) é configurado e guardado no Falaí.
>
> Este documento é a fonte de verdade para implementar o módulo. Os ecrãs de referência do Yeastar
> estão descritos em cada secção (o que replicar).

---

## 0. Decisão de arquitetura (ler primeiro)

O Falaí guarda e gere a **configuração**. Para as chamadas acontecerem, essa configuração é
consumida por um **motor de chamadas (call engine)**. Há duas camadas distintas:

1. **Camada de configuração (este módulo)** — modelos, API e UI. É o que se implementa aqui.
   É agnóstica ao motor.
2. **Camada de runtime (motor SIP)** — quem regista o trunk no provider (`87.238.224.117`) e
   origina/recebe RTP. Opções: motor SIP embebido (Asterisk/FreeSWITCH/drachtio gerido pelo
   Falaí) **ou** continuar a delegar a um PBX. Um `TrunkRuntimeAdapter` traduz a config do Falaí
   para o motor escolhido (gera `pjsip.conf`/dialplan, ou chama a API do motor).

> **Regra:** a config do Falaí é a fonte de verdade; o motor é sempre gerado/sincronizado a partir
> dela via `TrunkRuntimeAdapter.sync()`. Nunca se edita o motor à mão. Assim trocar de motor não
> afeta a UI nem os dados.

**Faseamento:** Fase 1–2 (config completa) não depende de escolher motor. A escolha do motor só é
necessária na Fase 4 (runtime). Implementar 1→2→3 primeiro; 4 depois.

---

## 1. Modelos de dados (Prisma) — `packages/db/prisma/schema.prisma`

Estende o schema atual (já existe `Tenant`, `TenantLine`). `TenantLine` fica **deprecado** e é
migrado para `Extension` (ver §6). Segredos SIP encriptados com o `crypto.service` (AES-256-GCM),
mesmo padrão do `pbxClientSecret`.

### 1.1 `Trunk` — trunk SIP para o provider

Reflete o ecrã *Trunk → Editar* (Básico / Avançadas / DDI / Cabeçalhos SIP).

```prisma
model Trunk {
  id            String   @id @default(cuid())
  tenantId      String?  // null = trunk partilhado (produto Operador); preenchido = BYO por tenant
  tenant        Tenant?  @relation(fields: [tenantId], references: [id])
  name          String   // ex: "TESTE.ANGOLA.AGV"
  enabled       Boolean  @default(true)
  itspTemplate  String   @default("GENERIC") // "Geral"
  type          TrunkType @default(REGISTER)  // Trunk de registo | peer
  // --- Ligação (dados do provider) ---
  transport     SipTransport @default(UDP)
  host          String   // "87.238.224.117"
  port          Int      @default(5060)
  domain        String?  // "87.238.224.117"
  authUser      String   // "878029113001" (Nome de utilizador)
  authName      String?  // "878029113001" (Nome de autenticação)
  authSecret    String   // encriptado (AES-256-GCM)
  outboundProxy String?
  // --- Avançadas ---
  codecs        String[] // ordenado: ["ulaw","alaw","g729","g726","g722","gsm"]
  dtmfMode      String   @default("RFC4733")   // RFC4733/RFC2833
  dtmfFmtp      String   @default("0-16")
  authErrorCodes String  @default("401;407;403")
  authRegAttempts Int    @default(3)
  regRetryIntervalS Int  @default(20)
  callRestriction String @default("OUTBOUND")  // Chamada de saída
  maxConcurrent Int?     // null = Ilimitado
  voipFlags     Json?    // { qualify, srtp, t38, inbandProgress, ignore183NoSdp, dedicated, ... }
  sipHeaders    Json?    // { inbound:{callerIdFrom,didFrom}, outbound:{fromUserPart,displayName,...}, other:{rel100,maxtime,...} }
  dids          TrunkDid[]
  inboundRoutes InboundRoute[]
  outboundRoutes OutboundRoute[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([tenantId])
}

model TrunkDid {
  id       String @id @default(cuid())
  trunkId  String
  trunk    Trunk  @relation(fields: [trunkId], references: [id], onDelete: Cascade)
  did      String // "244959100354"
  name     String?
  @@unique([trunkId, did])
}

enum TrunkType { REGISTER PEER }
enum SipTransport { UDP TCP TLS }
```

> **Regra de propriedade do trunk (decisão fixada):** `tenantId` distingue quem é dono.
> - `tenantId = null` → **trunk partilhado do operador** (produto Voice AI / `VOICE_AI`). Contém os
>   IPs/credenciais do provider e a rota internacional. Só o **backoffice** edita; no CRM é
>   **só-leitura**. Isto protege contra fraude (chamadas internacionais/premium que o operador paga),
>   mantém o segredo SIP central e deixa o controlo de saída (rota, caller id, concorrência) ligado
>   ao billing.
> - `tenantId = <tenant>` → **trunk BYO** (produto `CRM_BYO_PBX`). O cliente traz os próprios
>   IPs/credenciais e **edita no CRM**.
>
> Uma só regra, dois comportamentos — a UI decide read-only/editável a partir do `plan.productType`
> (`VOICE_AI` vs `CRM_BYO_PBX`), sem construir dois módulos. Ver §3 e §5.

### 1.2 `Extension` — substitui `TenantLine`

Reflete *Extensão → Editar* (abas Utilizador/Presença/Voicemail/Funcionalidades/Avançadas/Segurança/Clientes).

```prisma
model Extension {
  id            String   @id @default(cuid())
  tenantId      String
  tenant        Tenant   @relation(fields: [tenantId], references: [id])
  number        String   // "1000"
  callerId      String   // ID de chamador exibido
  displayName   String?  // Primeiro/Último nome
  email         String?
  mobile        String?
  roleId        String?
  role          Role?    @relation(fields: [roleId], references: [id])
  // --- Registo SIP (o softphone/webphone regista com isto) ---
  sipAuthUser   String   @unique  // "Nome de registo", ex "7jyXTI2S56"
  sipAuthSecret String            // encriptado (AES-256-GCM) — "Palavra passe de registo"
  maxIpRegs     Int      @default(4)
  maxWebRegs    Int      @default(3)
  // --- Config (JSON por aba, para não explodir colunas) ---
  presence      Json?    // { forwarding:{internal,external}, ringStrategy, ringTimeoutS:30 }
  voicemail     Json?    // { enabled, pinAuth, emailNotify, greeting }
  features      Json?    // { recording:"NONE|PAUSE|START", moh, businessHours:{tz:"WAT"}, monitored }
  voip          Json?    // { dtmf:"RFC4733", transport:["UDP","TCP"], qualify:true, t38, srtp }
  security      Json?    // { disallowIntl:true, ipRestriction, sipAgentAuth }
  isActive      Boolean  @default(true)
  isDefault     Boolean  @default(false)  // linha por defeito (migra TenantLine.isDefault)
  phoneNumber   String?  // DID público associado (migra TenantLine.phoneNumber)
  groups        ExtensionGroupMember[]
  outboundRoutes OutboundRoutePermission[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@unique([tenantId, number])
  @@index([tenantId])
}
```

### 1.3 Grupos, Funções e Rotas

```prisma
model ExtensionGroup {
  id        String @id @default(cuid())
  tenantId  String
  name      String // "VENDAS", "SUPORTE", "Default_All_Extensions"
  isDefault Boolean @default(false)
  permissions Json?  // painel de operações (redirecionar, transferir, monitorizar, ...)
  members   ExtensionGroupMember[]
  @@unique([tenantId, name])
}
model ExtensionGroupMember {
  extensionId String
  groupId     String
  extension   Extension      @relation(fields: [extensionId], references: [id], onDelete: Cascade)
  group       ExtensionGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  @@id([extensionId, groupId])
}

model Role {
  id          String @id @default(cuid())
  tenantId    String
  name        String // Administrator, Supervisor, Operator, Employee, ...
  permissions Json   // matriz por módulo (ver §4)
  extensions  Extension[]
  @@unique([tenantId, name])
}

// Encaminhamento de saída: que extensões podem usar que trunk, com que caller id
model OutboundRoute {
  id        String @id @default(cuid())
  tenantId  String
  name      String // "Default_Outbound_Route", "SHARE_AGV_OUT", "To_S50"
  trunkId   String
  trunk     Trunk  @relation(fields: [trunkId], references: [id])
  dialPattern String?  // prefixo/regex de números permitidos
  callerId  String?
  priority  Int    @default(0)
  permissions OutboundRoutePermission[]
  @@unique([tenantId, name])
}
model OutboundRoutePermission {
  routeId     String
  extensionId String
  route       OutboundRoute @relation(fields: [routeId], references: [id], onDelete: Cascade)
  extension   Extension     @relation(fields: [extensionId], references: [id], onDelete: Cascade)
  @@id([routeId, extensionId])
}

// Encaminhamento de entrada: DID → destino (extensão, grupo, IVR, agente IA)
model InboundRoute {
  id          String @id @default(cuid())
  tenantId    String
  name        String
  trunkId     String
  trunk       Trunk  @relation(fields: [trunkId], references: [id])
  didPattern  String // "244959100354"
  destType    String // EXTENSION | GROUP | IVR | AI_AGENT
  destValue   String // número da extensão / id do grupo / id do agente
  createdAt   DateTime @default(now())
  @@index([tenantId])
}
```

Relações a adicionar no `Tenant`: `extensions Extension[]`, `trunks Trunk[]`,
`extensionGroups ExtensionGroup[]`, `roles Role[]`, `outboundRoutes OutboundRoute[]`,
`inboundRoutes InboundRoute[]`.

---

## 2. Serviços — `apps/api/src/services/`

- **`sipProvisioning.service.ts`**
  - `generateSipCredentials()` → `{ authUser, authSecret }` (aleatórios, ex. `7jyXTI2S56` + segredo forte).
  - `createExtension(tenantId, dto)` / `updateExtension` / `deleteExtension` — valida `number` único, aplica defaults dos ecrãs (ring timeout 30 s, DTMF RFC4733, transporte UDP/TCP, disallowIntl=true), encripta `sipAuthSecret`.
  - `createTrunk` / `updateTrunk` — encripta `authSecret`, valida host/porta.
  - Cada mutação chama `TrunkRuntimeAdapter.sync(tenantId)` (Fase 4; no-op até lá).
- **`callRouting.service.ts`**
  - `resolveOutbound(extension, to)` → escolhe `OutboundRoute`/`Trunk` (substitui `resolveOutboundExtension`, ver memória `project-falai-outbound-extension-per-tenant`).
  - `resolveInbound(did)` → destino.
- **`crypto.service.ts`** — reutilizar (já existe) para segredos SIP.

---

## 3. Rotas API — `apps/api/src/routes/tenant/`

Novo ficheiro `extensions.ts` (registar em `index.ts` como `tenantExtensionsRoutes`, prefixo
`/tenant/extensions`) + `trunks.ts`, `roles.ts`, `routing.ts`. `preHandler: [fastify.verifyTenant]`,
`fastify.audit(...)` em cada mutação (padrão de `pbx.ts`). Segredos SIP **nunca** devolvidos em texto
(só reset/regenerar, tal como as passwords de utilizador — memória `project-falai-tenant-users-admin`).

```
GET    /tenant/extensions                 lista
POST   /tenant/extensions                 criar (gera sipAuthUser/secret)
GET    /tenant/extensions/:id             detalhe
PUT    /tenant/extensions/:id             editar (abas: presence/voicemail/features/voip/security)
POST   /tenant/extensions/:id/reset-sip   regenerar segredo de registo
DELETE /tenant/extensions/:id
GET/POST/PUT/DELETE /tenant/extension-groups
GET/POST/PUT/DELETE /tenant/roles
GET/POST/PUT/DELETE /tenant/trunks        (POST/PUT/DELETE: só admin/backoffice no produto Operador)
GET/POST/DELETE     /tenant/trunks/:id/dids
GET/POST/PUT/DELETE /tenant/outbound-routes  /tenant/inbound-routes
```

**Autorização do trunk (aplica a regra de §1.1):**
- `POST/PUT/DELETE /tenant/trunks` e `/tenant/*-routes` sobre um trunk com `tenantId = null` →
  **negado** no CRM; permitido só via backoffice. O backoffice faz CRUD do `Trunk` global e associa
  rotas a tenants.
- Sobre um trunk com `tenantId = <tenant>` (BYO-PBX) → o próprio tenant edita no CRM.
- `GET` é sempre permitido ao tenant a que o trunk se aplica (para mostrar em só-leitura).

---

## 4. Funções/Roles — matriz de permissões (JSON)

Replica o ecrã *Função → Editar*. `Role.permissions` é um JSON com chaves por módulo; o FE renderiza
os checkboxes a partir deste esquema. Roles seed: `Administrator, Supervisor, Operator, Employee,
Human Resource, Accounting, Hotel Manager`.

```jsonc
{
  "extensionAndTrunk": { "manageExtensions": "ALL|SAME_GROUP|SPECIFIC|SELF",
    "linkusClients": true, "groups": true, "clientPermission": true, "trunks": false, "roles": false },
  "contacts": { "company": true, "phonebooks": true, "ldap": true },
  "callControl": { "inboundRoute": false, "outboundRoute": false, "autoclip": false,
    "businessHours": true, "emergencyNumber": true },
  "callFeatures": { "voicemail": true, "featureCode": true, "ivr": false, "ringGroup": false,
    "queue": false, "conference": false, "speedDial": false, "paging": false },
  "ai": { "receptionist": false, "toolbox": false },
  "messaging": { "channel": true, "queue": true, "campaign": true },
  "system": { "dateTime": true, "email": false, "storage": false },
  "reports": { "cdr": true, "recordings": true, "callReports": true, "externalChatLogs": true },
  "integration": true, "security": false, "maintenance": false
}
```

---

## 5. UI — CRM (`apps/crm`) e Backoffice

Nova página no CRM: `apps/crm/src/pages/telephony/` (ou `settings/telephony`), no menu como
**"Telefonia"** / **"Extensões e trunk"**. i18n PT/EN/ZH (padrão das outras páginas — memórias
`project-falai-contract-fixes`). Sub-abas espelham o Yeastar:

- **Extensões** — tabela (número, nome/caller id, role, email, estado) + editor com abas
  Utilizador / Presença / Voicemail / Funcionalidades / Avançadas / Segurança / Clientes.
  Botão "Regenerar credenciais SIP" mostra `sipAuthUser`/segredo **uma vez**.
- **Grupos de extensões** — nome + membros + permissões.
- **Funções** — matriz de checkboxes a partir do esquema §4.
- **Trunk** — Básico (host/porta/transporte/user/secret) / Avançadas (codecs, DTMF, restrições) /
  DID / Cabeçalhos SIP. **Regra de renderização (fixada):** a UI lê `plan.productType` —
  `VOICE_AI` → aba Trunk em **só-leitura** (banner "gerido pelo operador"); `CRM_BYO_PBX` →
  **editável** pelo cliente. Mesmo componente, prop `readOnly` derivada do produto. No backoffice a
  edição do trunk partilhado (`tenantId = null`) é sempre completa.
- **Rotas** — saída (extensões↔trunk↔caller id) e entrada (DID→destino).

Reutilizar componentes de tabela/form já existentes (ver `pages/team`, `pages/settings`).

---

## 6. Migração de `TenantLine`

1. Criar modelos novos + migração Prisma.
2. Script `scripts/migrate-tenantline-to-extension.ts`: para cada `TenantLine` cria `Extension`
   (`number = extension`, `phoneNumber`, `isDefault`, `isActive`), gera credenciais SIP.
3. Trocar `resolveOutboundExtension` → `callRouting.resolveOutbound` (mantém regra: linha obrigatória,
   sem fallback global). Atualizar chamadas em `calls`, `campaigns`, `otp`, `v1`.
4. Manter `TenantLine` como deprecado 1 release; depois remover.

---

## 7. Dados de referência (seed inicial — trunk Angola)

Para semear/validar o módulo com a config real dos screenshots:

**Trunk `TESTE.ANGOLA.AGV`** (dados do provider — os únicos externos):
- type `REGISTER`, transport `UDP`, host/domain `87.238.224.117`, port `5060`
- authUser/authName `878029113001`, authSecret `<provider>`
- codecs `[ulaw, alaw, g729, g726, g722, gsm]`, dtmf `RFC4733`, fmtp `0-16`
- authErrorCodes `401;407;403`, regAttempts `3`, retry `20s`, callRestriction `OUTBOUND`, maxConcurrent `null`
- DID: `244959100354`

**Extensões** `1000–1004` (config nativa Falaí):

| number | callerId | role | email | mobile |
|--------|----------|------|-------|--------|
| 1000 | 1000 | Administrator | juvenal.dias1539.com@gmail.com | — |
| 1001 | 1001 | Supervisor | ludmilabuanga@gmail.com | — |
| 1002 | 1002 | Operator | — | — |
| 1003 | 1003 | Operator | — | — |
| 1004 | 1004 | Administrator | zaptelpipa@gmail.com | 933400967 |

Defaults por extensão: ring timeout `30s`, forwarding→voicemail, DTMF `RFC4733`, transport `UDP+TCP`,
qualify on, `security.disallowIntl = true`.

**Grupos:** `Default_All_Extensions`(1000-1004), `VENDAS`, `SUPORTE`(3), `FACTURACAO`(2),
`FACTPLUS KITADIPLUS`(1).

**Rotas de saída:** `Default_Outbound_Route`, `SHARE_AGV_OUT`, `To_S50` → trunk `TESTE.ANGOLA.AGV`.

---

## 8. Ordem de implementação (checklist)

- [~] **Fase 1 — Dados:** modelos Prisma (§1) ✅, migração `20260726120000_native_pbx_module` ✅
      (aditiva, não toca `TenantLine`), seed `pnpm --filter @falai/db seed:pbx` ✅.
      **Falta aplicar** (DB estava desligada): `pnpm --filter @falai/db migrate:dev` depois
      `ENCRYPTION_KEY=... pnpm --filter @falai/db seed:pbx`.
- [x] **Fase 2 — Config extensões:** `sipProvisioning.service` ✅ + rotas `/tenant/extensions`,
      `/tenant/extension-groups`, `/tenant/roles` ✅ (registadas em index.ts, verifyTenant+audit,
      segredo SIP revelado 1x) + página CRM `pages/telephony/TelephonyPage` com tabs
      Extensões/Grupos/Funções ✅ + i18n PT/EN/ZH ✅ + nav "Telefonia" ✅. Typecheck api+crm limpo.
      **Pendente:** editores das abas avançadas da extensão (presença/voicemail/voip/segurança) —
      hoje só campos base; os JSON já existem no modelo e API aceita-os.
- [x] **Fase 3 — Trunk & rotas:** rotas API `admin/trunks` (backoffice, trunk partilhado + DIDs),
      `tenant/trunks` (GET só-leitura p/ VOICE_AI, editável BYO), `tenant/routing`
      (outbound/inbound) ✅ + `services/trunk.service` (serialize sem segredo) +
      `services/callRouting.service` (resolveOutboundFromExtensions/resolveInbound; ligado ao
      `outboundExtension.service` com fallback TenantLine) ✅ + UI backoffice `pages/trunks/TrunksPage`
      (+ nav "Trunks") ✅ + aba Trunk no CRM (só-leitura/edição por `productType`) + i18n ✅.
      Script `prisma/migrate-tenantline-to-extension.ts` (§6, idempotente, não apaga TenantLine) ✅.
      Typecheck api+crm+backoffice+db limpo. **Pendente:** aplicar migração/scripts com a DB a correr.
- [~] **Fase 4 — Runtime:** esqueleto pronto ✅ — `TrunkRuntimeAdapter` (interface + tipos neutros +
      `NoopTrunkRuntimeAdapter`) em `packages/providers/src/telephony/TrunkRuntimeAdapter.ts`;
      `services/pbxSync.service.ts` monta o snapshot (desencripta segredos) e chama `sync()`;
      `scheduleTenantPbxSync(tenantId)` ligado às mutações de extensões, trunk BYO e rotas.
      **Falta:** escolher o motor SIP real (Asterisk/FreeSWITCH/drachtio) e implementar o adaptador
      que substitui o Noop (gerar pjsip.conf/dialplan ou API do motor) + ligar `dial`/inbound.

> Fases 1–3 entregam o Falaí "igual ao Yeastar" na configuração. A Fase 4 liga a config às chamadas
> reais e é onde entram os IPs/IDs do provider no motor.
