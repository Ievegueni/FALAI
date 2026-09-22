# Falaí — Canais de texto (chat, email, Telegram)

> Plano para o Falaí atender por texto e substituir o Hoory num cliente que hoje
> usa lá chat, email e Telegram.
>
> Decisão tomada: **construção nativa, sem depender de plataforma de terceiros.**
> A alternativa avaliada e descartada foi montar um Chatwoot white-label com o
> Falaí ligado como agent bot (~3 semanas, mas cria dependência externa).
>
> Criado em 22/09/2026. Estado: **fases 1–5 implementadas e testadas localmente (22/09)**;
> da fase 6 feito o billing (preço por resposta da IA), webhooks e `/v1/conversations`.
> Falta: importação do Hoory, métricas nos relatórios, testes com bot/caixa reais.
> Ver `docs/ESTADO-E-PROXIMOS-PASSOS.md` §3.1c.

---

## 1. O buraco

O Falaí é hoje voz + SMS + CRM + campanhas + billing. Não tem nada do que o
cliente usa no Hoory: sem widget de chat, sem email, sem Telegram, sem caixa de
entrada unificada, sem conceito de `Conversation`/`Message` de texto — o
`Call`/`CallTurn` é de voz e está colado a STT/TTS/ARI.

## 2. Âmbito

**Dentro:** widget web, email, Telegram, caixa unificada no CRM, IA a responder,
passagem para humano, respostas rápidas, histórico.

**Fora, até pedirem:** WhatsApp, Instagram, Facebook, apps móveis, construtor
visual de bots, motor de automações/SLA, relatórios avançados.

Paridade com o Hoory nesses três canais é atingível. Copiar o produto inteiro é
como se perde o ano.

## 3. Arquitectura numa linha

Três adaptadores de canal → normalizador → `Conversation`/`Message` → roteador
(IA ou humano) → **o mesmo LLM/prompt/guardrails da voz** → resposta pelo canal
de origem. O SSE do screen pop já existente leva tudo ao CRM em tempo real.

**Reutiliza-se, sem alterar:** `IncomingCallHub` (já é genérico —
`broadcast(tenantId, event, data)`), `guardrail.service`, `agentCompiler`,
`modelResolver` (o BYOM funciona em texto tal como está), `billing.service`,
`webhookEmitter`, `crypto.service` para credenciais, multi-tenant e auth.

**Dependências novas em todo o plano:** só as três do email (`imapflow`,
`mailparser`, `nodemailer`). Telegram e widget fazem-se com `fetch` e SSE.

---

## 4. Fases

### Fase 1 — Fundação (1 semana)

**Schema** — cinco modelos e uma migração delicada:

```prisma
enum Channel { WEBCHAT EMAIL TELEGRAM }
enum ConversationStatus { OPEN PENDING RESOLVED }
enum ConversationMode { AI HUMAN }

model Inbox {        // tenantId, channel, name, agentId?, config Json (cifrado), autoReply
model Conversation { // tenantId, inboxId, contactId?, assigneeId?, status, mode,
                     // subject?, externalRef, lastMessageAt
                     // @@index([tenantId, status, lastMessageAt])
model Message {      // conversationId, seq, role (reusa TurnRole), text, attachments,
                     // externalId, llmMs, guardrailFlags, costCents
                     // @@unique([conversationId, seq])
model CannedResponse // tenantId, shortcut, text
```

**Mina nº1 — `Contact.phone`.** É obrigatório e `@@unique([tenantId, phone])`.
Um visitante do widget ou um contacto de Telegram não tem telefone. Tem de
passar a `String?`, mais `email String?` e `telegramId String?`, e **toda** a
chamada a `findUnique({ tenantId_phone })` tem de ser revista antes da migração.
Fazer isto primeiro, sozinho, não empilhado com outro trabalho.

```
// ponytail: duas colunas de identidade em vez de tabela ContactIdentity.
// Migrar para tabela quando entrar o 4º canal.
```

**Motor de texto.** Extrair do `TurnProcessor` a parte que não é áudio — LLM +
guardrails + histórico — para `processTextTurn()`. O `TurnProcessor` da voz
passa a chamá-la. Uma função, não uma classe nova. No `agentCompiler`, o prompt
deixa de dizer "assistente de voz" e passa a receber o canal.

**Mina nº2 — `Agent.ttsVoiceId`** é obrigatório. Um agente só de texto não tem
voz: tornar opcional.

### Fase 2 — Telegram (1 semana)

O canal mais barato, e prova o pipeline de ponta a ponta.

- Bot API pura com `fetch`, zero dependências.
- `POST /webhooks/telegram/:inboxId` — segredo no path, como já se faz em
  `/webhooks/pbx/:token`.
- `setWebhook` ao guardar o inbox; `sendMessage` para responder.
- `chat.id` é o `externalRef`.

No fim desta fase há IA a conversar por texto, gravada, cobrada e visível por
SSE. Tudo o resto são mais canais e UI. **É o que se demonstra ao cliente — não
esperar pela Fase 6.**

### Fase 3 — Widget web (1,5 semanas)

- `widget.js` em vanilla, ~200 linhas, servido pela própria API. Nada de React
  num script que corre no site de terceiros.
- Sessão = token opaco em `localStorage`.
- `POST /public/chat/:inboxKey/message` + `GET /public/chat/:token/stream`
  (SSE, o padrão já usado na casa).
- CORS restrito aos domínios autorizados do inbox; rate limit por token —
  `@fastify/rate-limit` já está instalado.
- Visitante anónimo → `Conversation.contactId` nulo até dar email ou telefone;
  aí funde com o `Contact`.

### Fase 4 — Email (1,5 semanas no papel, o dobro na prática)

O canal difícil. **Não ser servidor de email.** O cliente faz forward de
`suporte@ele.com` para uma caixa nossa; lê-se por IMAP, responde-se por SMTP com
`Reply-To` do domínio dele.

- `imapflow`, `mailparser`, `nodemailer` — as únicas dependências novas do plano.
- Polling a cada 60s num job BullMQ (o worker já existe). Mais simples e mais
  robusto que IMAP IDLE.
- Threading por `Message-ID` / `In-Reply-To` / `References`, guardados em
  `externalRef`.
- **Cortar o texto citado** antes de mandar ao LLM, ou o custo por mensagem
  explode e a IA responde ao histórico dela própria.

**Mina nº3:** SPF/DKIM/DMARC no domínio de envio, bounces, e anexos. Não há S3
no projecto — anexos em disco, servidos com autenticação de tenant.

### Fase 5 — Caixa de entrada no CRM (2 semanas)

`apps/crm/src/pages/inbox/` — três colunas: lista de conversas (filtro por
estado, inbox e atribuição) | thread | painel do contacto.

- Ligação SSE para mensagens novas e mudanças de estado.
- Atribuir, resolver, nota interna, resposta rápida por `/atalho`, assumir da IA
  (`mode: HUMAN`) e devolver.
- Bloqueio optimista por `updatedAt` para dois agentes na mesma conversa.
- Sem presença nem indicador de "está a escrever" — adicionar quando reclamarem.

### Fase 6 — Fecho e migração (2 semanas)

- `BillingMode.PER_CONVERSATION` / `PER_MESSAGE` no `Plan`, com override por
  tenant. O padrão já existe no `billing.service`.
- Métricas de texto nos relatórios existentes; eventos de conversa no
  `webhookEmitter` e em `/v1/conversations`.
- Script de importação do export do Hoory: contactos, histórico, respostas
  rápidas, utilizadores. (O Hoory é um fork do Chatwoot — o formato de export é
  reconhecível e o mapeamento é quase directo.)
- Telegram: apontar o bot existente para o nosso webhook, o token não muda.
  Email: mudar o forward. Widget: trocar o snippet no site.
- **Uma semana a correr em paralelo** com o Hoory antes de cancelar.

---

## 5. Prazo

**≈ 9 semanas para um dev.** Contar 12 com o email a correr mal.

| Fase | Semanas |
|---|---|
| 1 — Fundação (schema + `processTextTurn`) | 1 |
| 2 — Telegram | 1 |
| 3 — Widget web | 1,5 |
| 4 — Email | 1,5 (→ 3) |
| 5 — Caixa de entrada no CRM | 2 |
| 6 — Billing, relatórios, migração, piloto | 2 |

## 6. Riscos

1. **`Contact.phone`** — migração transversal ao código todo. É o risco técnico
   nº1 e está na primeira semana de propósito.
2. **Email** — vale metade do esforço total apesar de ser uma fase de três.
   Entregabilidade e threading são onde se perde tempo, não o IMAP.
3. **A voz ainda não fala.** O `externalMedia` está por fazer (ver
   `docs/ESTADO-E-PROXIMOS-PASSOS.md`). Se se promete "omnicanal com IA" e a voz
   não responde, perde-se o cliente pela parte que ele nem pediu. **Vender o
   texto primeiro.**
4. **Custo de LLM em texto** é muito mais barato que em voz — fazer tabela de
   preços própria, não copiar a da voz.
5. **Retenção e privacidade** do histórico de texto: definir política antes de
   importar anos de conversas do Hoory.

## 7. Próximo passo

Fase 1: migração do `Contact` (phone opcional + email/telegramId) e extracção do
`processTextTurn` a partir do `TurnProcessor`.
