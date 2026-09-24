# Falaí — WhatsApp Active/Standby com fallback automático

> Guia de implementação. Criado em 24/09/2026. Estado: **implementado em 24/09/2026, por commitar**
> (passos 1–8 do §10; falta o teste com números reais — passo 9).
>
> Onde ficou: `services/waPool.service.ts` (estado, lock, health check, failover),
> `routes/public/wa.ts` (link), `routes/webhooks/whatsapp.ts` (encaminhamento por
> `phone_number_id` + eventos de conta), `routes/tenant/inboxes.ts` (acções admin),
> `crm/.../InboxSettingsPage.tsx` (`WaPoolCard`), migração `20260924120000_whatsapp_pool`,
> teste `services/waPool.test.ts`.
>
> Backoffice: aba "WhatsApp" no detalhe do tenant — números, estado, último check/erro,
> histórico de trocas (`GET /admin/tenants/:id/whatsapp`) e health check pelo suporte, por número
> ou a todos (`POST /admin/tenants/:id/whatsapp/check`, auditado; pode provocar failover). Quem adiciona e gere
> os números é o cliente, no CRM.
>
> Diferenças face ao plano: sem email de alerta (SSE `wa.pool` +
> SystemEvent); a regra "todos falham na mesma ronda = global" foi substituída por
> classificar como `ignore` tudo o que não seja um código/estado do próprio número;
> o webhook de conta não mapeia a WABA — dispara um health check imediato do pool do tenant.
>
> Regra adicional: um número (`phoneNumberId`) só pode estar ligado a um canal em toda a
> plataforma — índice `Inbox_wa_phone_number_unique` (migração `20260924130000`) + 409 na API
> sem revelar o outro cliente. Apagar o canal liberta o número.
>
> Motivo: há clientes com risco de ver um número WhatsApp banido/restrito. O
> site do cliente tem **um só botão**; o Falaí decide para que número o manda.

---

## 1. O que já existe (e o que muda)

| Peça | Onde | Estado |
|---|---|---|
| Canal WhatsApp Cloud API (1 número = 1 `Inbox` com `channel = WHATSAPP`) | `routes/tenant/inboxes.ts`, `services/textChannels.service.ts` | commitado |
| Token/App Secret cifrados em `Inbox.config` (`inboxSecret()`) | `inboxes.ts` `SECRET_KEYS` | commitado |
| Verificação do número na criação (`checkWhatsapp` → `GET /{phone-number-id}`) | `inboxes.ts:120` | commitado |
| Webhook por inbox `/webhooks/whatsapp/:inboxId` | `routes/webhooks/whatsapp.ts` | commitado |
| **Link público `/public/wa/:tenantId` → 302 para `wa.me`** | `routes/public/wa.ts` | **por commitar** — reparte por *least connections* |

**Decisão:** o link público mantém-se (é o "`GET /whatsapp`" pedido), mas a
estratégia passa de *least connections* para **Active/Standby**.

Porquê trocar e não ter as duas: repartir por todos os números expõe todos ao
mesmo risco ao mesmo tempo. Com Active/Standby os números em standby ficam
"frios" — é esse o objectivo aqui.

**Não criar a tabela `whatsapp_numbers` proposta.** Cada número já é um `Inbox`
com `phone_number_id`, token cifrado e webhook. Uma tabela paralela duplicava
isso e punha o `access_token` noutro sítio (possivelmente em claro). Basta
acrescentar ao `Inbox` os campos de estado do pool.

---

## 2. Modelo de dados

```prisma
enum WaPoolStatus {
  ACTIVE    // recebe os cliques do botão
  DEGRADED  // é o número em serviço, mas com erros abaixo do limiar
  STANDBY   // pronto, à espera
  FAILED    // confirmado indisponível; só volta por acção manual
  DISABLED  // retirado do pool pelo admin
}

model Inbox {
  // ...campos actuais...
  // Só WHATSAPP. Null = número fora do pool do link público.
  waStatus      WaPoolStatus?
  waPriority    Int?          // 1 = primeiro na ordem de fallback
  waFailCount   Int           @default(0) // falhas consecutivas (circuit breaker)
  waLastCheckAt DateTime?
  waLastError   String?
  waStatusAt    DateTime?     // última mudança de estado (= failed_at quando FAILED)
}
```

Migração SQL à mão (o Prisma não suporta índices parciais no schema):

```sql
-- Garante na BD que nunca há dois números "em serviço" no mesmo tenant.
CREATE UNIQUE INDEX "Inbox_one_active_wa"
  ON "Inbox" ("tenantId")
  WHERE "waStatus" IN ('ACTIVE', 'DEGRADED') AND "deletedAt" IS NULL;
```

`DEGRADED` entra no índice porque continua a ser o número que recebe clientes —
é um `ACTIVE` sob suspeita, não um estado de standby.

Mapeamento para os campos pedidos: `phone_number` = `config.displayPhone`,
`display_name` = `name`, `phone_number_id` e `access_token` = `config` (token
cifrado), `whatsapp_business_account_id` → acrescentar `config.wabaId`
(opcional, útil para receber `account_update`), `failed_at` = `waStatusAt`
quando `waStatus = FAILED`.

---

## 3. Routing — `GET /public/wa/:tenantId`

```
1. Ler da BD o número com waStatus IN (ACTIVE, DEGRADED)       ← sem chamar a Meta
2. Existe → 302 para wa.me/<dígitos>[?text=...]
3. Não existe → promover o STANDBY de menor waPriority (transacção §5) → 302
4. Nenhum elegível → página simples com alternativa (widget/telefone) + alerta
```

Regras:

- **Não chamar a Meta no clique.** O pedido original diz "confirmar que está
  operacional" a cada clique; isso mete 300 ms+ de Graph API em cada visita,
  gasta rate limit e — pior — um soluço da Meta passa a derrubar números. O
  estado é mantido pelo health check (§4); o routing só lê a BD.
- Resposta **302 com `Cache-Control: no-store`**. Nunca 301: o browser
  guardava o redirect e o cliente ficava preso ao número antigo depois do
  failover.
- Cache em memória de 10–15 s do número activo por tenant é aceitável; a troca
  invalida-a.
- Manter o `tenantHasFeature(tenantId, "inbox")` e o `?text=` que já existem.

No site do cliente fica só:

```html
<a href="https://api.falai.../public/wa/<tenantId>?text=Olá" target="_blank" rel="noopener">
  🟢 Falar connosco pelo WhatsApp
</a>
```

---

## 4. Detecção de falha (health check + circuit breaker)

### 4.1 Três fontes de sinal

1. **Health check periódico** — de 60 em 60 s, para **todos** os números do
   pool (incluindo standby: não adianta fazer failover para um número que
   também está partido).
   `GET /{phone-number-id}?fields=status,quality_rating,name_status,code_verification_status`
   Correr no processo da API, no mesmo padrão de `startEmailPolling`
   (`services/email.service.ts:127`), porque `whatsappApi` e `inboxSecret`
   vivem lá. Várias instâncias da API não fazem mal: a transacção (§5) é
   idempotente.
2. **Webhooks de conta da Meta** — subscrever, além de `messages`, os campos
   `account_update` (ban/restrição/violação) e `phone_number_quality_update`.
   Sinal imediato, sem esperar pelo próximo check.
3. **Erros ao enviar resposta** — em `textChannels.service.ts:312`, quando o
   envio falhar, passar o erro a `reportWaError(inboxId, err)`.

### 4.2 Classificar antes de contar

Isto é o que impede o efeito dominó (WA1→WA5 todos FAILED por causa de uma
falha que não é deles):

| Sinal | Classe | Acção |
|---|---|---|
| `status` = `BANNED`, `DELETED`, `DISCONNECTED`; `account_update` com ban/desactivação; erro de conta bloqueada (ex.: 131031) | **Definitivo, do número** | FAILED já (após 1 retry de confirmação) |
| `status` = `RESTRICTED`/`RATE_LIMITED`; erro de bloqueio temporário por política (ex.: 368) | **Suspeito, do número** | `waFailCount++`; limiar → FAILED |
| `quality_rating = RED`, `status = FLAGGED` | Aviso | Alertar; **não** trocar (o número ainda funciona) |
| Timeout, 5xx, rede, rate limit (4, 80007, 130429) | **Global / nosso** | Não conta. Alertar se persistir |
| Token inválido/expirado (190) | **Configuração** | Não conta. Alertar. Os 5 números costumam partilhar o token — trocar não resolvia |

> Confirmar os códigos e valores de `status` na documentação da Meta no dia da
> implementação — mudam entre versões da Graph API (estamos em `v21.0`).

Regra extra: se **todos** os números do tenant falharem na mesma ronda, é
global — não conta para nenhum.

### 4.3 Circuit breaker

```
check falha (suspeito) → retry com 2 s de espera → falha outra vez → waFailCount++
waFailCount = 1..2  → número em serviço passa a DEGRADED (continua a receber)
waFailCount ≥ 3     → FAILED + failover (≈ 3 min de falha contínua)
check OK            → waFailCount = 0; DEGRADED volta a ACTIVE
definitivo          → salta o contador, FAILED após o retry
```

Standby com falhas: fica `STANDBY` com `waLastError` visível; no limiar passa a
`FAILED` e deixa de ser elegível.

**Sem regresso automático.** Um número FAILED só volta a STANDBY por acção
manual — evita *flapping* (troca, volta, troca) e obriga alguém a perceber
porque falhou.

---

## 5. Failover transaccional

Uma função só, usada pelo health check, pelo webhook, pelo `reportWaError` e
pelo routing (caso 3):

```ts
async function failover(tenantId: string, failedId: string | null, reason: string) {
  return prisma.$transaction(async (tx) => {
    // Serializa trocas do mesmo tenant entre pedidos/instâncias.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"wa-pool:" + tenantId}))`;

    const current = await tx.inbox.findFirst({
      where: { tenantId, channel: "WHATSAPP", deletedAt: null, waStatus: { in: ["ACTIVE", "DEGRADED"] } },
    });
    // Outro processo já trocou: não fazer nada, devolver o actual.
    if (current && current.id !== failedId) return current;

    const next = await tx.inbox.findFirst({
      where: { tenantId, channel: "WHATSAPP", enabled: true, deletedAt: null, waStatus: "STANDBY", waFailCount: 0 },
      orderBy: { waPriority: "asc" },
    });
    const now = new Date();
    // Despromover ANTES de promover — o índice parcial nunca é violado.
    if (current) await tx.inbox.update({ where: { id: current.id }, data: { waStatus: "FAILED", waStatusAt: now, waLastError: reason } });
    if (next) await tx.inbox.update({ where: { id: next.id }, data: { waStatus: "ACTIVE", waStatusAt: now, waFailCount: 0 } });
    // AuditLog (actorType "system") com before/after + notificação (§7).
    return next;
  });
}
```

Três camadas contra corrida: advisory lock por tenant, re-leitura dentro do
lock (quem chega tarde vê que já foi trocado) e o índice único parcial como
última garantia.

---

## 6. Página de administração

**No CRM** (o tenant gere os seus números), como secção "Pool WhatsApp" dentro
de `pages/inbox/InboxSettingsPage.tsx`, onde já aparece o link. No backoffice,
só leitura no detalhe do tenant (para suporte).

Tabela: número · nome · estado (badge) · prioridade · último check · último
erro · última mudança de estado. Em destaque: qual está ACTIVE e o link a pôr
no site.

Rotas novas em `routes/tenant/inboxes.ts` (ou `wa-pool.ts`), todas pela mesma
transacção/lock do §5:

| Acção | Rota | Nota |
|---|---|---|
| Listar pool | `GET /tenant/inboxes/wa-pool` | nunca devolve token |
| Activar | `POST /tenant/inboxes/:id/wa-activate` | actual → STANDBY, este → ACTIVE; recusar se o check falhar |
| Standby | `POST /tenant/inboxes/:id/wa-standby` | se era o ACTIVE, promove o seguinte |
| Desactivar | `POST /tenant/inboxes/:id/wa-disable` | idem |
| Reordenar | `PUT /tenant/inboxes/wa-pool/order` `{ ids: [...] }` | reescreve `waPriority` 1..n numa transacção |
| Health check manual | `POST /tenant/inboxes/:id/wa-check` | corre o check já, devolve o resultado |
| Repor FAILED | `POST /tenant/inboxes/:id/wa-standby` | mesma rota; limpa `waFailCount` |

Tudo vai para o `AuditLog` (actor = utilizador ou `system`).

---

## 7. Alertas

Uma troca automática **tem** de avisar — senão o cliente só descobre que perdeu
um número semanas depois:

- evento SSE para o CRM (já temos o canal do screen pop) + email ao admin do tenant;
- aviso no backoffice (suporte Falaí);
- alerta também quando sobram 0 números em standby, e quando o check global
  falha (token/Meta em baixo).

---

## 8. Pré-requisito que encontrei: webhook partilhado

Uma **app da Meta tem um só URL de callback**. Se os 5 números estiverem na
mesma app/WABA, a Meta manda as mensagens dos 5 para o URL de um só inbox — e
hoje o `routes/webhooks/whatsapp.ts` mete tudo nesse inbox, sem olhar para o
número de destino.

Corrigir antes do pool: no POST, ler `change.value.metadata.phone_number_id` e
encaminhar para o `Inbox` do tenant com esse `config.phoneNumberId` (validando
a assinatura com o `appSecret`, que é o mesmo na mesma app). Sem isto, as
conversas do WA2 depois do failover caem no inbox do WA1.

---

## 9. Limites que o cliente tem de saber (importante)

1. **O fallback não protege de um ban ao nível da conta.** Se os 5 números
   estão na mesma WABA (ou no mesmo Business Manager) e a Meta sanciona a
   conta/empresa, caem todos de uma vez. Para risco real, os números de
   standby deviam estar em WABAs separadas — o que o próprio cliente tem de
   montar e verificar na Meta.
2. **Não é forma de fugir a sanções.** As políticas da Meta proíbem contornar
   medidas de enforcement; usar o standby para continuar exactamente o que
   causou o ban tende a escalar a sanção para a empresa inteira. Depois de um
   failover: ver o motivo no WhatsApp Manager, recorrer se for injusto,
   corrigir a causa. O fallback serve para continuidade operacional — que é o
   que o pedido diz.
3. **Conversas antigas ficam no número antigo.** Clientes que falavam com o
   WA1 não passam para o WA2. O histórico continua visível no CRM (o
   `Contact` é o mesmo, pelo telefone), mas o WA2 só pode escrever-lhes se
   eles escreverem primeiro, ou com template aprovado. **Não** disparar
   templates em massa do WA2 para os contactos do WA1 — é o padrão exacto que
   a Meta pune.
4. **Os standby têm de estar prontos antes.** Registados na Cloud API (PIN de
   2 passos), nome aprovado (`name_status`), webhook configurado e agente
   associado. O health check de standby (§4.1) confirma isto.
5. **Limites de envio:** números novos começam no tier mais baixo para
   conversas iniciadas pela empresa. Como o botão gera conversas iniciadas
   pelo cliente, isto quase não pesa — mas campanhas não devem sair do número
   recém-activado.

---

## 10. Ordem de implementação

1. Corrigir o encaminhamento do webhook por `phone_number_id` (§8).
2. Migração: enum + campos + índice parcial (§2).
3. `failover()` + `reportWaError()` + teste da corrida (duas chamadas em
   paralelo → um só ACTIVE).
4. Health check periódico + classificação (§4) — com teste da tabela de
   classificação (um `*.test.ts` como `guardrail.test.ts`).
5. Reescrever `routes/public/wa.ts` para Active/Standby (§3).
6. Webhooks `account_update` / `phone_number_quality_update`.
7. Rotas admin + secção no CRM + vista no backoffice (§6).
8. Alertas (§7).
9. Testar com 2 números reais: desligar um (ex.: remover o registo na Cloud
   API) e ver a troca, o alerta e o redirect novo.

Estimativa: ~3–4 dias, sem contar com o tempo de preparar os números na Meta.
