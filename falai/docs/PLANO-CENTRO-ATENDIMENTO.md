# Falaí — Centro de atendimento (tickets, Freshdesk, QA, alertas)

> Plano para cobrir o levantamento de requisitos da MANO
> (`Requisitos - Aplicação de Gestão de Chamadas.xlsx`) **como produto**, não
> como projecto à medida: tudo o que entra aqui serve qualquer tenant e liga-se
> por funcionalidade no backoffice.
>
> Criado em 06/10/2026. Estado: **fases 1 (tickets), 2 (papéis), 4 (alertas/SLA),
> 5 (pausas/turnos/sessões) e 7 (qualidade) feitas em 06/10, branch `feat/tickets`**
> — migrações `20261006090000_tickets`, `20261006120000_manager_role`,
> `20261006150000_service_alerts`, `20261006180000_agent_time` e
> `20261006200000_quality` aplicadas só na BD local. Fase 3 (Freshdesk) à espera
> de conta de testes da MANO.

---

## 1. O buraco

Comparando o documento com o código (06/10), cerca de metade está feita:
canais, gravação, screen pop, tipificação, estados do agente, supervisão
(ouvir/sussurrar/intervir), TMA/TME, abandonadas, exportação CSV/Excel, audit
log, perfis de acesso.

Falta, por blocos:

| Bloco | O que falta |
|---|---|
| Tickets | Não existe entidade Ticket. Sem níveis 1º/2º/3º, estados, reabertura, ligação chamada↔conversa↔ticket |
| Helpdesk externo | Zero integração com Freshdesk/Freshchat |
| Alertas e metas | Sem alertas (espera, atendimento, sem agentes), sem SLA/ASA, sem metas nem desvios |
| Agentes | Pausa sem motivo, sem turnos, sem registo de sessões |
| Telefonia de atendimento | Sem transferência/espera entre humanos, filas sem estratégia nem tempo máximo, sem callback |
| Qualidade | Sem formulários, QA score, feedback, auditoria de avaliações |
| Satisfação | Sem CSAT |
| Reporting | Sem consolidado multicanal, sem ligação a Power BI, dashboard de direcção parcial |
| Papéis | "Agente só vê o que é seu" não existe; sem base de conhecimento |
| Continuidade | Sem documento de contingência nem alertas de indisponibilidade ao cliente |

**Pré-requisito que não muda:** a voz real pela ANGOVOIP ainda não foi provada
(`ESTADO-E-PROXIMOS-PASSOS.md` §4.3). Tudo o que é voz neste plano constrói-se
e testa-se localmente, mas só se dá por fechado depois da chamada real.

## 2. Decisão central: tickets nas duas formas

Cada tenant escolhe, no backoffice, onde vivem os tickets:

- **`NATIVE`** — os tickets vivem no Falaí. Para clientes sem helpdesk.
- **`FRESHDESK`** — o Freshdesk é a fonte de verdade; o Falaí guarda uma
  **cópia espelho** e sincroniza nos dois sentidos.

**Um só modelo `Ticket` nos dois modos.** No modo Freshdesk a linha tem
`externalSystem="FRESHDESK"` + `externalId`. Vantagens:

- CRM, relatórios, QA, ligações a chamadas/conversas e permissões são **o mesmo
  código** nos dois modos — só muda quem escreve primeiro.
- Os relatórios consolidados não precisam de consultar o Freshdesk ao vivo.
- Se a sincronização falhar, o agente continua a trabalhar; a fila de envio
  repõe depois.

Regra de escrita no modo Freshdesk: o Falaí **envia primeiro ao Freshdesk** e
actualiza o espelho com a resposta. Os webhooks do Freshdesk actualizam o
espelho quando a alteração nasce lá. Em conflito ganha o Freshdesk.

Conector: um módulo `freshdesk.service.ts`, sem interface genérica. Quando
entrar o segundo helpdesk (Zendesk, etc.) extrai-se a interface a partir dos
dois casos reais.

## 3. Fases

Tamanhos: **P** ≈ 1–3 dias · **M** ≈ 1 semana · **G** ≈ 2 semanas.
Todas as migrações são **aditivas** (produção tem clientes reais).
Cada fase nova nasce como funcionalidade desligada (`FEATURE_KEYS`) e
liga-se por cliente no backoffice.

### Fase 1 — Tickets nativos (G) · feature `tickets` · ✅ feita 06/10

Feito: schema + migração, `services/tickets.service.ts` (+ teste),
`/tenant/tickets` e `/v1/tickets` (scopes `tickets:read|write`), webhooks
`ticket.created`/`ticket.updated`, CRM (lista, detalhe, criar a partir de
chamada/conversa/screen pop/perfil), tickets movem-se na união de contactos.
Ficou de fora: prazo automático (SLA) — vem com a fase 4; limite de N dias para
reabrir (hoje reabre-se sempre a partir de RESOLVED; CLOSED é final).

Schema:
- `Ticket`: `number` (sequencial por tenant), `subject`, `description`,
  `status` (`OPEN | PENDING | ON_HOLD | RESOLVED | CLOSED`), `priority`
  (`LOW | MEDIUM | HIGH | URGENT`), `supportLevel` (1/2/3), `categoryId` +
  `subcategoryId` (**reutiliza `CallCategory`**), `contactId`, `assigneeId`
  (TenantUser), `groupId` (ExtensionGroup = equipa), `source` (canal de
  origem), `dueAt`, `resolvedAt`, `closedAt`, `reopenCount`,
  `externalSystem?`, `externalId?` (`@@unique([tenantId, externalSystem, externalId])`).
- `TicketEvent`: histórico e notas (criado, estado, prioridade, nível,
  responsável, nota interna, resposta) — dá a "reabertura e encerramento" e a
  auditoria do caso.
- `Call.ticketId?` e `Conversation.ticketId?` — a associação
  chamada↔conversa↔ticket. Uma chamada/conversa pertence no máximo a um ticket;
  um ticket junta várias.

API: `/tenant/tickets` (lista com filtros, detalhe, criar, actualizar,
escalar nível, reabrir, fechar, ligar/desligar chamada ou conversa).
`/v1/tickets` com scopes `tickets:read|write`. Webhooks `ticket.*`.

CRM:
- Página **Tickets** (lista + detalhe com linha do tempo de eventos,
  chamadas e conversas ligadas).
- Criar ticket a partir do **screen pop**, do detalhe da chamada e da
  conversa na caixa de entrada.
- Perfil do cliente passa a mostrar os tickets.

Regras: reabrir só a partir de `RESOLVED` (configurável: até N dias);
`CLOSED` é final. Escalar nível regista evento e pode mudar de grupo.

### Fase 2 — Papéis e "só o que é meu" (P) · ✅ feita 06/10

**Mudança face ao plano:** criou-se o papel `MANAGER` em vez de simular o
gestor com um perfil de acesso — um perfil não separa "usar a caixa de
entrada" de "configurar canais", nem tapa as definições/webhooks. Com isso os
perfis-modelo deixaram de ser precisos (não feitos).

| Documento | Falaí |
|---|---|
| Administrador | `OWNER`/`ADMIN` — tudo, incluindo configuração técnica |
| Gestor Operacional | `MANAGER` — toda a operação (relatórios, equipa, supervisão, tipificações); gere supervisores/agentes/consultas, não administradores |
| Supervisor | `SUPERVISOR` — a sua equipa (grupos supervisionados e os agentes deles) |
| Agente | `MEMBER` — só o que é seu |

Feito: `services/userScope.ts` (âmbito único para tickets, conversas,
chamadas, relatórios) + testes; VIEWER só consulta em todas as rotas
(`tenantAuth`); definições/webhooks/chaves API/PBX só OWNER/ADMIN (antes
qualquer utilizador mudava o webhook); SSE manda ao agente só o id das
conversas; CRM esconde o que daria 403; "Membro" passou a chamar-se "Agente".

Limites conhecidos: o "tenant" nos relatórios de atendimento continua a ser a
média da conta (referência das comparações); Dashboard e perfil do cliente
não são filtrados (o histórico do cliente é para o agente ver); o papel vem no
JWT — mudar o papel de alguém só vale depois de voltar a entrar.

Plano original (para referência):

O que falta construir:
- Escopo por papel nas listas: `MEMBER` vê só tickets/conversas atribuídos a
  si (e o que está por atribuir no seu grupo); relatórios só os seus;
  `SUPERVISOR` vê os dos seus grupos. Uma função de filtro partilhada,
  aplicada nas rotas de tickets, conversas, chamadas e relatórios.
- **Perfis-modelo** no backoffice ("Gestor Operacional", "Agente") para não
  configurar à mão em cada cliente.

### Fase 3 — Conector Freshdesk + Freshchat (G) · modo `FRESHDESK`

Configuração por tenant (backoffice e CRM → Integrações): domínio, API key
(**encriptada**, como as credenciais de PBX), modo `NATIVE | FRESHDESK`,
mapeamento de grupos e de agentes (por email `TenantUser` ↔ agente Freshdesk).

Do Falaí para o Freshdesk (job BullMQ com retry, nunca no pedido HTTP):
- Identificação: no screen pop, procurar contacto no Freshdesk por telefone/
  email e mostrar os tickets abertos dele.
- Fim de chamada: criar ticket ou acrescentar nota ao ticket escolhido, com
  tipificação, resumo da IA e ligação para a gravação.
- Alterações feitas no Falaí (estado, prioridade, responsável) → `PUT` no
  Freshdesk.

Do Freshdesk para o Falaí:
- Webhook (regra de automação deles) → `/webhooks/freshdesk/:tenantId` com
  segredo por tenant → actualiza o espelho.
- Reconciliação periódica (tickets alterados desde a última sincronização)
  para apanhar webhooks perdidos.

Freshchat:
- Ler conversas do utilizador (por telefone/email) e mostrá-las no perfil do
  cliente e no screen pop — **só leitura**.
- Se o cliente quiser trocar o Freshchat pela caixa de entrada do Falaí, isso
  é uma migração à parte, não esta fase.

Cuidados: limites de pedidos por minuto do plano Freshdesk (fila com
cadência); nunca bloquear o atendimento se o Freshdesk estiver em baixo.

### Fase 4 — Alertas, SLA/ASA e metas (M) · ✅ feita 06/10

Feito: `Tenant.serviceTargets` + tabela `Alert`; `services/alerts.service.ts`
(avaliador a cada 15 s **na API**, não no worker — o estado ao vivo vive lá;
duplicados entre instâncias impedidos por `openKey` único) + testes; SLA nos
KPIs de atendimento (limiar configurável, 21 s por omissão); o TME existente
é o ASA (rótulo "TME (ASA)"). Entrega: aviso no ecrã por SSE (só supervisão),
painel de alertas abertos e histórico (relatório de desvios) na Supervisão,
webhooks `alert.opened`/`alert.closed`. Metas em Supervisão → Definições.

Ficou de fora: email/SMS directo (não há SMTP do sistema — o webhook serve
para encaminhar); metas por grupo (só por cliente); alertas do produto
CRM_BYO_PBX (não temos o estado ao vivo do PBX deles).

Plano original:

Por tenant (e opcionalmente por grupo): `maxWaitSecs`, `maxHandleSecs`,
`minAvailableAgents`, `slaThresholdSecs` (21 por omissão), `slaTargetPct`,
metas de TMA/abandono.

- **SLA e ASA** entram em `attendanceReport.service.ts` (os dados já existem:
  `queuedAt`, `answeredAt`). Gráficos e exportações apanham-nos de graça.
- **Avaliador ao vivo**: job no worker a cada ~15 s lê o estado que a
  supervisão já calcula e dispara alertas (espera alta, atendimento longo, sem
  agentes disponíveis).
- Entrega: SSE para supervisores (o canal do screen pop já existe) e email/SMS
  opcional. Tabela `Alert` (tipo, grupo, valor, limite, início, fim) para
  histórico e relatório de desvios.
- **Desvios face às metas**: comparação diária dos KPIs com as metas.

### Fase 5 — Agentes: motivos de pausa, turnos, sessões (M) · ✅ feita 06/10

Feito: `PauseReason`, `AgentPause`, `AgentSession`, `Shift`;
`services/agentTime.service.ts` (+ testes); motivos em Telefonia → Motivos de
pausa (gestor/admin); webphone pede o motivo ao pausar; supervisão mostra o
motivo; turnos na Equipa (gestor/admin, supervisor para a equipa); relatório
"Tempo dos agentes" (escalado, ligado, aderência, pausas por motivo) com o
âmbito do papel. Sessões = canal SSE do CRM aberto (sem pedidos extra).
Corrigido: qualquer utilizador pausava a extensão de outro.

Limites: turnos não passam da meia-noite e a UI tem um horário por dia;
"ligado" é ter o CRM aberto (não o registo SIP); com várias instâncias da API
o fecho de sessões órfãs no arranque tem de passar a ser por instância.

Plano original:

- `PauseReason` (igual a `RejectReason`) e `AgentPause` (início, fim, motivo)
  em vez de só `Extension.pausedAt`. Relatório de tempo em pausa por motivo.
- `AgentSession` (login/logout no CRM/webphone) para tempo logado e
  produtividade.
- `Shift` (utilizador, dias da semana, hora de início/fim) + relatório de
  aderência (escalado vs. logado vs. em pausa). Sem motor de escalas
  automáticas — o supervisor define os turnos à mão.

### Fase 6 — Telefonia de atendimento (G) · depende da voz real

- **Transferência** (cega e assistida) e **espera** no webphone. As chamadas
  passam pelo Stasis, por isso faz-se com operações de bridge no ARI.
- **Filas**: estratégia por grupo (todos / rotativo / menos recente), tempo
  máximo de espera e destino de transbordo (outro grupo, voicemail, callback).
- **Callback**: na fila, quem liga carrega numa tecla e desliga; nasce um
  `CallbackRequest` que aparece aos agentes do grupo e se liga com o
  click-to-call que já existe. Reaproveita o fluxo de chamadas perdidas.

### Fase 7 — Qualidade (QA) (G) · feature `quality` · ✅ feita 06/10

**Mudança face ao plano:** em vez de versões do formulário, cada avaliação
guarda a cópia do formulário (`formSnapshot`) — mesmo efeito, menos peças.

Feito: `QaForm`, `QaEvaluation`; `services/quality.service.ts` (score no
servidor: peso dos conformes / peso avaliado, N/A fora, eliminatório = 0) +
testes; agente da chamada descoberto sozinho (quem atendeu); amostra aleatória
por agente; agente confirma ou contesta; avaliador/gestor revê (antes/depois
no AuditLog); página Qualidade (avaliações, QA score por agente, por avaliar,
editor de formulários) e botão "Avaliar" no detalhe da chamada.

Ficou de fora: pré-preenchimento pela IA; avaliar conversas/tickets pela UI
(a API já aceita `conversationId`/`ticketId`).

Plano original:

- `QaForm` (secções, critérios, peso, critérios eliminatórios) com versões —
  uma avaliação fica presa à versão do formulário em que foi feita.
- `QaEvaluation` (chamada, conversa ou ticket; agente; avaliador; respostas;
  **score calculado no servidor**; comentário).
- Feedback ao agente com confirmação de leitura e contestação.
- Auditoria: quem avaliou, alterou e quando (`AuditLog`).
- Amostragem: lista de interacções por avaliar (aleatória por agente/semana).
- Opcional: a IA (que já analisa relatórios) pré-preenche uma sugestão; o
  avaliador decide sempre.

### Fase 8 — CSAT (M)

- Voz: depois do agente desligar, a chamada segue para um inquérito DTMF de
  1 a 5 (Asterisk, mesmo mecanismo do IVR).
- Texto: pergunta no fim da conversa (widget/WhatsApp) e link por SMS.
- `CsatResponse` ligada à chamada/conversa/ticket e ao agente. Entra nos
  relatórios por agente, grupo e canal.

### Fase 9 — Reporting consolidado e Power BI (M)

- Relatório **consolidado** chamadas + conversas + tickets por dia/semana/mês
  e por canal (as métricas de texto ainda não estão nos relatórios — entram aqui).
- **Dashboard de direcção**: KPIs de topo, SLA, CSAT, QA, tendência.
- **Power BI**: endpoints `/v1/reports/*` só de leitura, planos (uma linha por
  registo), com chave de API com scope `reports:read`. O Power BI liga-se pelo
  conector Web. Sem OData nem conector próprio até alguém pedir.

### Fase 10 — Base de conhecimento (P)

`KbArticle` (título, corpo, categoria, publicado). Pesquisa no CRM ao lado do
screen pop e do ticket. Extra barato: a IA dos canais de texto pode usá-la
como contexto.

### Fase 11 — Continuidade do serviço (P, sobretudo documento)

- Documento entregável ao cliente: procedimentos em caso de indisponibilidade,
  backup (pg_dump diário + restauro testado), redundância disponível, plano de
  continuidade.
- Alerta de indisponibilidade: o health check que já existe passa a notificar
  o operador e os administradores do tenant.
- Interacções afectadas por falhas: a fila de sincronização do Freshdesk e os
  webhooks já repõem; chamadas que caíram ficam marcadas e aparecem para
  callback.

## 4. Ordem proposta

1. Fase 1 (tickets nativos) + Fase 2 (papéis) — base de tudo o resto.
2. Fase 4 (alertas, SLA/ASA) — pequena, muito visível para a MANO.
3. Fase 3 (Freshdesk/Freshchat) — assim que houver conta de testes da MANO.
4. Fase 5 (pausas, turnos).
5. Fase 7 (QA) e Fase 8 (CSAT).
6. Fase 6 (telefonia de atendimento) — quando a voz real estiver provada.
7. Fases 9, 10, 11.

Total aproximado: **12–14 semanas** de trabalho de uma pessoa.

## 5. Perguntas em aberto

- [ ] MANO: conta Freshdesk de testes (sandbox) + API key; plano Freshdesk
      (webhooks por automação dependem do plano).
- [ ] MANO: o Freshchat continua a ser o canal de chat deles, ou passam para a
      caixa de entrada do Falaí?
- [ ] CSAT: inquérito por tecla no fim da chamada, por SMS, ou os dois?
- [ ] Power BI: chega o conector Web com chave de API, ou o IT deles quer
      acesso directo a uma base de leitura?
- [ ] Número de agentes e supervisores — define a cadência dos alertas e os
      limites da API do Freshdesk.
