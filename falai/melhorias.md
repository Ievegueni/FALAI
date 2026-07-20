# Melhorias — Módulo Clínica (ficha do contacto por licença)

> Documento de implementação. Segue as fases **por ordem**. Cada passo tem o
> ficheiro exacto, a localização e o padrão a replicar. Não avançar para a fase
> seguinte sem o `typecheck` da fase anterior estar limpo.

> **Estado: ✅ IMPLEMENTADO E VERIFICADO** (Opção A — flag `clinicEnabled`).
> Fases 1–4 concluídas, `typecheck` limpo nas 3 apps. Verificação fim-a-fim OK:
> o flag chega à sessão, a ficha clínica persiste em `attributes`, o gating
> funciona nos dois sentidos. `plan_pro` (tenant demo) ficou com Clínica ligada.
> A BD foi aplicada via `prisma db push` (o projeto não usa pasta de migrações).

---

## 1. Objetivo

Permitir que clientes do tipo **clínica** giram no CRM a *ficha do paciente*
(dados de contacto, última consulta, próxima consulta, médico, alergias, notas)
**e que esses campos só apareçam se o cliente tiver a licença de Clínica**.

- **Sem licença** → o contacto continua a funcionar como hoje (nome, telefone).
- **Com licença** → aparece a secção "Ficha clínica" com os campos extra.

---

## 2. Princípios (ler antes de tocar em código)

1. **Reaproveitar, não reinventar.** O gating de licença já existe: o flag
   `Plan.aiAgentsEnabled` já flui até ao CRM via `tenant.plan`. O módulo clínica
   replica **exactamente esse padrão** com um novo flag `clinicEnabled`.
2. **Dados clínicos vão no `Contact.attributes` (JSON) — não criar colunas.**
   O modelo `Contact` já tem `attributes Json?` e a API já aceita/devolve. Zero
   migração para os dados. A **única** migração é o flag booleano no `Plan`.
3. **A UI faz o gating, o backend não bloqueia `attributes`.** O backend continua
   a aceitar attributes livres; é o CRM que só *expõe* os campos clínicos quando
   `tenant.plan.clinicEnabled === true`.
4. **Não quebrar contactos existentes.** `attributes` é opcional; contactos sem
   dados clínicos renderizam a ficha vazia, não rebentam.

---

## 3. Decisão pendente (confirmar antes da Fase 1)

**Como modelar a licença de Clínica?**

- ✅ **Opção A (recomendada): flag `clinicEnabled` no `Plan`.** Um cliente pode ter
  "Pro + Clínica". Segue o padrão `aiAgentsEnabled`. É o assumido neste documento.
- Opção B: novo `productType = "CLINIC"`. Mais rígido (clínica passa a ser um
  produto exclusivo, não combinável). Só seguir se o negócio exigir isolamento total.

> Este documento implementa a **Opção A**. Se for a B, trocar o flag por um valor
> de enum e ajustar os selects/condições em conformidade.

---

## 4. Arquitetura (fluxo do flag)

```
Backoffice (PlansPage)  →  PATCH /admin/plans/:id { clinicEnabled }
        │
        ▼
   Plan.clinicEnabled (BD)
        │
        ▼
tenant/auth (select do plano)  →  tenant.plan.clinicEnabled  →  AuthContext (CRM)
        │
        ▼
ContactDetailPage: if (tenant.plan.clinicEnabled) mostra "Ficha clínica"
        │
        ▼
Campos guardados em Contact.attributes (JSON)  ⇄  PATCH /tenant/contacts/:id
```

---

## 5. Campos clínicos (contrato do `attributes`)

Guardados como chaves dentro de `Contact.attributes`. Sugestão inicial:

| Chave              | Tipo     | Label na UI          |
|--------------------|----------|----------------------|
| `nrProcesso`       | string   | Nº de processo       |
| `dataNascimento`   | string (ISO date) | Data de nascimento |
| `ultimaConsulta`   | string (ISO date) | Última consulta   |
| `proximaConsulta`  | string (ISO date) | Próxima consulta  |
| `medicoResponsavel`| string   | Médico responsável   |
| `alergias`         | string   | Alergias             |
| `notas`            | string   | Notas clínicas       |

> Chaves são livres — este conjunto é o que a UI expõe. Manter os nomes em
> camelCase e estáveis (são a "chave de contrato" com o frontend).

---

## 6. Checklist de implementação

### Fase 1 — Base de dados (1 migração)

- [ ] **`packages/db/prisma/schema.prisma`** — modelo `Plan` (≈ linha 227, junto a
      `aiAgentsEnabled`):
      ```prisma
      clinicEnabled       Boolean     @default(false) // acesso ao módulo Clínica
      ```
- [ ] Gerar migração + cliente:
      ```bash
      cd packages/db
      npx prisma migrate dev --name add_clinic_enabled_to_plan
      npx prisma generate
      ```
- [ ] Confirmar coluna: `psql $DATABASE_URL -c '\d "Plan"' | grep clinicEnabled`

### Fase 2 — API (backend)

- [ ] **`apps/api/src/routes/admin/plans.ts`**
  - `createSchema` (≈ linha 8, junto a `aiAgentsEnabled`):
    ```ts
    clinicEnabled: z.boolean().default(false),
    ```
  - `updateSchema` — adicionar o mesmo campo (opcional).
  - No mapeamento do `update` (≈ linha 70), replicar o padrão:
    ```ts
    ...(body.clinicEnabled !== undefined && { clinicEnabled: body.clinicEnabled }),
    ```
  - No `create`, garantir que `clinicEnabled` é passado ao `prisma.plan.create`.

- [ ] **`apps/api/src/routes/tenant/auth.ts`** — adicionar `clinicEnabled: true`
      aos **dois** selects de plano:
  - Linha ≈135 (resposta de login): hoje só tem `name, maxAgents, maxConcurrent`.
    Acrescentar `clinicEnabled: true` (e, por consistência, `productType`, `aiAgentsEnabled`).
  - Linha ≈225 (sessão / `me`): já tem `productType, aiAgentsEnabled` → juntar
    `clinicEnabled: true`.

- [ ] **`apps/api/src/routes/tenant/contacts.ts`** — no `GET /:id` (≈ linha 139),
      o `select` das `calls` incluídas **não** traz `toNumber` nem `kind`.
      Acrescentar para a timeline ficar completa:
      ```ts
      calls: { orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, toNumber: true, kind: true, status: true,
                  outcome: true, durationSecs: true, createdAt: true } }
      ```

- [ ] `cd apps/api && npx tsc --noEmit` → **limpo**.

### Fase 3 — Backoffice (gestão de planos)

- [ ] **`apps/backoffice/src/pages/plans/PlansPage.tsx`** — adicionar um toggle
      "Módulo Clínica" ao lado do toggle de "Agentes de IA" (`aiAgentsEnabled`).
      Localizar o input de `aiAgentsEnabled` e replicar o mesmo controlo para
      `clinicEnabled` (form state, checkbox, envio no create/update).
- [ ] Confirmar o tipo do plano na camada `api.ts` do backoffice inclui
      `clinicEnabled` (procurar onde `aiAgentsEnabled` está tipado e juntar).
- [ ] `cd apps/backoffice && npx tsc --noEmit` → **limpo**.

### Fase 4 — CRM (ficha do contacto)

- [ ] **`apps/crm/src/types/index.ts`**
  - No tipo do `plan` (≈ linha 46, onde estão `productType`/`aiAgentsEnabled`):
    ```ts
    clinicEnabled?: boolean;
    ```
  - No tipo `Contact`, garantir `attributes?: Record<string, unknown>`.

- [ ] **`apps/crm/src/lib/api.ts`** — `contactsApi.get(id)` e `.update(id, data)`
      **já existem**. Confirmar apenas que `update` envia `attributes`. Sem trabalho
      novo esperado aqui.

- [ ] **NOVO: `apps/crm/src/pages/contacts/ContactDetailPage.tsx`**
  - Rota `/contacts/:id`. `useQuery(['contact', id], () => contactsApi.get(id))`.
  - Cabeçalho: nome, telefone, botão editar.
  - **Secção "Ficha clínica"** — renderizar **apenas** se
    `tenant?.plan?.clinicEnabled === true` (via `useAuth()`). Campos da tabela da
    secção 5, editáveis, guardados com `contactsApi.update(id, { attributes })`.
  - **Timeline de chamadas** — mapear `contact.calls` (já vêm no `get`).

- [ ] **`apps/crm/src/pages/contacts/ContactsPage.tsx`** — tornar cada linha
      clicável: `onClick={() => navigate('/contacts/' + contact.id)}`
      (o `useNavigate` já é usado noutras páginas — replicar padrão da CallsPage).

- [ ] **`apps/crm/src/App.tsx`** — registar a rota:
      ```tsx
      <Route path="/contacts/:id" element={<ContactDetailPage />} />
      ```

- [ ] `cd apps/crm && npx tsc --noEmit` → **limpo**.

---

## 7. Verificação (fim-a-fim, com o stack a correr)

1. **Backoffice**: criar/editar um plano e ligar "Módulo Clínica". Atribuir esse
   plano ao tenant de teste (ou activar no plano do `tenant_demo`).
2. **Login CRM** com esse tenant → confirmar no payload de sessão que
   `tenant.plan.clinicEnabled === true`.
3. **Abrir um contacto** (`/contacts/:id`) → a secção "Ficha clínica" aparece.
   Preencher "última consulta" e "alergias", guardar, recarregar → persiste.
4. **Tenant sem a licença** → a secção clínica **não** aparece; contacto normal.
5. Comando de sanidade:
   ```bash
   TOKEN=$(curl -s -X POST http://localhost:3000/tenant/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"demo@demo.com","password":"demo123"}' \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
   curl -s http://localhost:3000/tenant/contacts -H "Authorization: Bearer $TOKEN" | head
   ```

---

## 8. Riscos e rollback

- **Migração**: só adiciona coluna booleana com `default(false)` → não afecta
  dados existentes. Rollback = `prisma migrate` para a migração anterior.
- **Contactos sem attributes**: a ficha renderiza campos vazios — validar que a UI
  usa `attributes?.chave ?? ''` (nunca acesso directo sem optional chaining).
- **Dois selects no `auth.ts`**: esquecer um deles faz o flag chegar só em
  parte dos fluxos. Actualizar **ambos** (login + sessão).

---

## 9. Fora de âmbito (fica para o "módulo estruturado", se um dia for pedido)

- Modelo `Appointment` dedicado (agendamento real, estados, médico por consulta).
- Filtros/ordenação de contactos por data de consulta.
- Lembretes automáticos de consulta por voz (usar o motor de chamadas + campanhas).
- Relatórios/dashboard clínico.

---

## Anexo — Correções já aplicadas (contexto)

Fora do módulo clínica, já foram corrigidos nesta sessão:

- **Chamadas directas não apareciam no CRM** — `POST /tenant/calls/direct` passou a
  persistir um registo `Call` com `kind: "DIRECT"`; o hangup fecha-o como `COMPLETED`.
  (`apps/api/src/routes/tenant/calls.ts`)
- **Dashboard do cliente rebentava** — `DashboardPage.tsx` acedia a `call.agent.name`
  com `agent` a null (chamada directa). Corrigido com badge por `kind` + fallback;
  o endpoint `tenant/dashboard` passou a devolver o campo `kind`.
- **Botão rápido de chamada** — na lista de Contactos (ícone verde por linha) e na
  ficha do contacto (botão "Ligar" no header). Navega para `/calls/direct` com o
  número pré-preenchido via `location.state.to`; reaproveita o fluxo de chamada
  directa existente (sem duplicar lógica). `DirectCallPage` passou a aceitar o
  número inicial pelo estado de navegação.
