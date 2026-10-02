# Sprints

## Melhoria 1/4 — Relatórios e KPIs de atendimento (iniciada a 02/10/2026)

Contexto: as 4 melhorias são (1) relatórios e KPIs, (2) tipificação de
chamadas, (3) histórico do cliente na entrada, (4) supervisão em tempo real.

Decisões da Fase 0:
- "Agente" = `Extension`; "grupo" = `ExtensionGroup` (ring group simultâneo, não
  há fila/ACD). TME = atendimento − início do toque (`Call.queuedAt`).
- Cada toque numa extensão é uma `CallLeg` (hardphone + webphone juntos).
  Recusa = SIP 603 (causa 21); o webphone recusa com 603, o hardphone da mesma
  extensão deixa de tocar.
- KPIs calculados no momento, com SQL agregado sobre índices
  `(tenantId, …, ringStartedAt)`. Sem job BullMQ: o volume actual cabe com folga;
  se um cliente passar de ~1M de pernas, trocar por rollup diário sem mudar os
  endpoints.
- Clientes CRM_BYO_PBX (Yeastar próprio): só TMA/atendidas/perdidas (o CDR do
  Yeastar não traz agente nem recusas).
- Dados por agente/grupo só existem a partir da Fase 1 (não há histórico).
- Estatísticas "só minhas" para agentes exigem ligar TenantUser↔Extension —
  fica para a melhoria 4.

### Fase 1 — Captura ✅
- [x] Migração aditiva: `CallLeg`, `RejectReason`, `Call.queuedAt/groupId`.
- [x] `AsteriskAdapter`: causa de cada perna do ring group; variáveis no originate.
- [x] Router de entrada grava pernas (ANSWERED/REJECTED/BUSY/NO_ANSWER/CANCELLED/FAILED).
- [x] Testes: classificação das causas e fluxo do router.

### Fase 2 — Motivos de recusa ✅
- [x] `/tenant/reject-reasons` (lista; criar/editar/desactivar só OWNER/ADMIN; não se apagam).
- [x] `POST /tenant/call-legs/:id/reject-reason` (só enquanto a perna toca).
- [x] CRM: aba Telefonia → Motivos de recusa.
- [x] Webphone: "Recusar" abre o modal de motivo (lista + "Outro") e só depois envia 603.

### Fase 3 — KPIs no backend ✅
- [x] `attendanceReport.service.ts`: TMA, TME, tempo de resposta, perdidas/abandonadas, recusadas, motivos.
- [x] `GET /tenant/reports/attendance` (tenant, selecção, por agente, por grupo, motivos; filtros from/to/extensionId/groupId).
- [x] `GET /tenant/reports/attendance/calls` (paginado, com pernas).
- [x] `GET /tenant/reports/attendance/export?view=agents|groups|reasons&format=csv|xlsx`.
- [x] Comparação com a média do tenant (`vsTenant`); BYO-PBX devolve `limited: true`.
- [x] Testes de cada KPI (`attendanceReport.test.ts`).

### Fase 4 — Aba Relatórios ✅
- [x] Separadores: Resumo (actual), Atendimento, Por agente, Por grupo, Recusas, Chamadas.
- [x] Filtros comuns: hoje/semana/mês/30 dias/intervalo, agente, grupo.
- [x] Comparação com a média da empresa (Δ por linha; cartão "vs média" com filtro).
- [x] Exportação CSV/Excel (por agente, por grupo, motivos); CSV do Resumo mantém-se.

### Pendente / a validar
- [ ] Teste real: recusa no webphone com motivo → perna REJECTED com o motivo
      (precisa de uma chamada de entrada real pelo trunk).
- [ ] Confirmar que o PJSIP_HEADER do originate chega ao INVITE do webphone.

## Melhoria 2/4 — Tipificação de chamadas (iniciada a 02/10/2026)

Decisões da Fase 0:
- Não havia classificação humana: `Call.outcome` é o resultado técnico/da IA e
  `Call.summary` o resumo da IA. A tipificação fica na **perna que atendeu**
  (`CallLeg`: categoria, subcategoria, nota, `typedAt`, `typedById`), que já diz
  que agente e que grupo atenderam — serve os relatórios e o histórico (melhoria 3).
- Categorias em 2 níveis (`CallCategory.parentId`); desactivar em vez de apagar;
  associação opcional a grupos só nas categorias (vazio = todos). O agente vê as
  dos grupos da sua extensão + o grupo por onde a chamada tocou.
- Obrigatória (`Tenant.typingRequired`): no fim da chamada a perna ganha
  `wrapUpEndsAt = fim + typingMaxSecs`; até lá a extensão **não recebe chamadas
  novas** (o router de entrada salta-a). Ao expirar conta como "não tipificada"
  (estado calculado, sem job) — pode ser tipificada mais tarde.
- Pós-chamada (wrap-up) = fim → tipificação, limitado ao prazo; separado do TMA.
- Edições ficam no `AuditLog` (`call_leg.typing_changed`, antes/depois, quem).
- Fim de chamada no frontend: só o webphone o detecta. O formulário abre aí; a
  lista "Por tipificar" da extensão cobre as chamadas atendidas no telefone físico.
- Só chamadas de entrada (são as que têm pernas); chamadas directas ficam de fora.

### Fase 1 — Backend ✅
- [x] Migração aditiva: `CallCategory`, `CallCategoryGroup`, campos na `CallLeg`, `Tenant.typingRequired/typingMaxSecs`.
- [x] `/tenant/call-categories` (CRUD admin), `/tenant/call-typing/settings`.
- [x] `/tenant/call-legs/untyped?extensionId=`, `GET|PUT /tenant/call-legs/:id/typing`.
- [x] Router de entrada salta extensões dentro do prazo de tipificação.
- [x] Relatórios: filtro `categoryId`, volume por categoria/subcategoria, % não tipificadas e pós-chamada por agente, export `view=typing`.
- [x] Testes: obrigatoriedade, expiração, edição (auditoria), visibilidade, bloqueio no router, relatórios.

### Fase 2 — Frontend ✅
- [x] Telefonia → Tipificação: obrigatória/prazo + árvore de categorias com grupos.
- [x] Webphone: formulário pós-chamada (abre no fim de uma chamada de entrada atendida) + lista "Por tipificar" com contagem do prazo.
- [x] Relatórios: separador Tipificação, filtro por categoria, colunas "% não tipif." e "Pós-chamada" no "Por agente", tipificação na lista de chamadas, export CSV/Excel.

### Pendente / a validar
- [ ] Teste real: chamada atendida no webphone → formulário abre; com obrigatória, a extensão não toca até tipificar/expirar.

## Melhoria 3/4 — Histórico do cliente na entrada (screen pop) (iniciada a 03/10/2026)

Decisões da Fase 0:
- Números: mantém-se o formato de gravação do projecto (**9 dígitos nacionais**,
  `normalizeAoPhone`, decisão anterior contra duplicados); no ecrã mostra-se
  `+244 9XX XXX XXX`. A pesquisa aceita +244/244/00244/9 dígitos e ainda o
  legado `+244…` gravado. Internacionais mostram-se em bruto, sem identificação.
- Número oculto: vazio, só zeros/pontuação, `anonymous/unknown/restricted/private/…`.
- Vários números: `ContactPhone` (extra); unicidade entre as duas tabelas no código.
- Disparo do painel: o INVITE do webphone já traz `X-Falai-Leg-Id` → o painel
  pede `/tenant/callers/lookup?legId=` no toque e fecha com os eventos da sessão.
  Chega ao agente certo sem infra nova. Agentes só com telefone físico não têm
  painel; o banner do PBX próprio (BYO) usa `?number=`.
- O router de entrada passa a preencher `Call.contactId` → tipificação e notas
  da chamada ficam ligadas ao cliente.
- Histórico: todas as chamadas do contacto (entrada e saída), 10 + "ver mais".
- Cada consulta fica no AuditLog (`contact.history_viewed`).

### Fase 1 — Backend ✅
- [x] Migração aditiva: `ContactPhone`, `ContactNote`, índice `Call(tenantId, contactId, startedAt)`.
- [x] `callerLookup.service.ts` (classificação do número, pesquisa indexada, histórico, destaques, conversas, notas).
- [x] `/tenant/callers/lookup`, `/:contactId/history`, contacto rápido, editar, números extra, notas.
- [x] `/tenant/contacts` não cria duplicados de um número extra.
- [x] Scripts `pnpm -F api contactos:normalizar` (corrigido p/ canais de texto) e `contactos:associar-chamadas`. Dev: 330 contactos normalizados.
- [x] Testes: normalização, cliente existente, não identificado, oculto, auditoria, contacto rápido.

### Fase 2 — Frontend ✅
- [x] Painel do cliente no webphone (`components/calls/CallerPanel.tsx`): abre no toque, fica durante a chamada, fecha ao recusar/não atender/desligar.
- [x] Contacto rápido, edição (nome/email), números extra e notas durante a chamada.
- [x] Banner do PBX próprio (BYO) usa a pesquisa no servidor.
- [x] Pesquisa medida em dev: 10–27 ms.

### Pendente / a validar
- [ ] Chamada real: confirmar o formato do caller ID que a ANGOVOIP entrega e que o painel abre no toque.
- [ ] Produção: correr `contactos:normalizar` (dry-run, depois `--apply` com backup) e `contactos:associar-chamadas`.

## Melhoria 4/4 — Supervisão de chamadas em tempo real (iniciada a 03/10/2026)

Decisões da Fase 0:
- Só ARI (motor da plataforma). O Yeastar só existe nos clientes BYO, que usam
  a supervisão nativa do PBX deles.
- Modos: Escuta = snoop no canal do agente (spy=both, whisper=none) numa bridge
  "supervise-<sessão>"; Sussurro = idem com whisper=out; Intervenção = o canal do
  supervisor entra na bridge da conversa. Trocar de modo não desliga o
  supervisor; terminar nunca toca na conversa; fim do cliente/agente/supervisor
  termina a sessão; bridges órfãs varridas no arranque.
- Âmbito: chamadas de entrada atendidas (as que têm agente e grupo).
- O supervisor ouve na **sua extensão** (webphone atende sozinho com
  `X-Falai-Supervise`; o telefone físico também serve).
- Papel `SUPERVISOR` (TenantRole) com grupos atribuídos (`SupervisorGroup`);
  OWNER/ADMIN vêem tudo. `TenantUser.extensionId` liga utilizador ↔ extensão
  (regra "não supervisionar a própria chamada").
- Estados: em chamada / a tocar / pós-chamada / pausa / disponível / offline
  (registo do endpoint via ARI, cache de 5 s). Pausa nova: `Extension.pausedAt`,
  o router salta a extensão.
- Painel por polling (2 s) com as permissões de quem pede (o SSE é por tenant).
- Avisos: Sussurro/Intervenção avisam sempre o agente; Escuta só com
  `Tenant.supervisionNotifyListen`. Aviso ao cliente (Lei 22/11):
  `Tenant.monitoringNotice` + áudio `monitor_<tenant>`, tocado ao começar a conversa.
- Registo imutável `SupervisionEvent` (START/MODE/END) com trigger que recusa
  UPDATE/DELETE.

### Fase 1 — Backend ✅
- [x] Migração aditiva (+ trigger de imutabilidade).
- [x] `AsteriskAdapter`: snoop, removeChannelFromBridge, bridges com nome, listBridges, endpointState.
- [x] Router: `activeInboundCalls()`, pausa, aviso de monitorização.
- [x] `supervision.service.ts` (sessões, modos, limpeza) + `/tenant/supervision/*` (live, iniciar, modo, terminar, registo, definições, áudio, pausa).
- [x] Equipa: papel SUPERVISOR, extensão e grupos supervisionados.
- [x] Testes: cada modo, troca de modo, fim durante a supervisão, órfãos, própria chamada, 1 por chamada, âmbito, estados.

### Fase 2 — Frontend ✅
- [x] Página Supervisão (menu só para OWNER/ADMIN/SUPERVISOR): ao vivo (polling 2 s, contadores ao segundo), Escutar/Sussurrar/Intervir/Terminar, registo e definições (aviso em Escuta, aviso ao cliente + áudio).
- [x] Webphone: atende sozinho a chamada de supervisão (`X-Falai-Supervise`), aviso ao agente (SSE `supervision.agent`), botão Pausa.
- [x] Equipa: editar papel (com SUPERVISOR), extensão do utilizador e grupos supervisionados.

### Pendente / a validar (com chamadas reais)
- [ ] Escuta/Sussurro/Intervenção numa chamada real: direcção do áudio do snoop (`whisper=out` → só o agente ouve) e latência.
- [ ] Aviso ao cliente: carregar o áudio e confirmar que toca no início da conversa.
- [ ] Reinício da API a meio de uma supervisão → a bridge `supervise-*` é varrida no arranque.

## Melhoria 5/6 — Perfil do cliente (iniciada a 02/10/2026)

Fase 0 — o que já existe:
- `Contact`: name, phone (9 dígitos, único por tenant), email, telegramId,
  attributes, optedOutAt/optOutReason, createdAt/updatedAt. Números extra em
  `ContactPhone` e notas em `ContactNote` (melhoria 3). Ligado a Call,
  CampaignContact (único por campanha), SmsMessage, Conversation e SupervisionEvent.
- Reutilizável da melhoria 3: `callerLookup.service.ts` (`classifyCaller`,
  `phoneVariants`, `findContactIdByNational`, `historyState`, `mapHistory`) e
  as rotas `/tenant/callers/*` (editar, números extra, notas, auditoria
  `contact.history_viewed`). Da página Chamadas: `callsFilter.service.ts` e a
  exportação Excel (`excelExport.service.ts`).
- Frontend: já há lista `/contacts` com pesquisa e `/contacts/:id` (ficha
  simples: edição, ficha clínica, últimas 10 chamadas). O screen pop já liga a
  `/contacts/:id`. A pesquisa actual é `contains` (sem índice) e não normaliza
  o número.

Proposta:
- O perfil substitui `/contacts/:id` (mesma rota, mantém edição e ficha clínica).
- Schema (aditivo): extensão `pg_trgm` + índice GIN trigram em `Contact.name`
  (e em `phone`, para números parciais). Número completo → pesquisa exacta pelos
  índices únicos já existentes, depois de normalizar.
- Merge sem tabela nova: o duplicado é absorvido (chamadas, SMS, conversas,
  notas, campanhas, supervisões; o número dele passa a extra) e apagado; quem/
  quando/snapshot do apagado ficam no AuditLog `contact.merged`.

Decisões validadas: o perfil substitui `/contacts/:id`; merge apaga o
duplicado (snapshot na auditoria); o Leitor só consulta; exportação em Excel.

### Fase 1 — Backend ✅
- [x] Migração `20261004090000_contact_search_trgm` (pg_trgm + 2 índices GIN); pesquisa normalizada (número completo exacto, inclui extra; parte do nome/número por trigram).
- [x] Corrigido: a lista de contactos ignorava a pesquisa do CRM (`search` vs `q`) e o total não era filtrado.
- [x] `services/contactProfile.service.ts` + `routes/tenant/contactProfile.ts`: `GET /:id/profile` (cabeçalho, resumo, tipificações, notas), `GET /:id/calls` (filtros + paginação), `/:id/calls/export.xlsx`, números extra, `POST /:id/merge`.
- [x] Auditoria: `contact.history_viewed` (perfil/exportação) e `contact.merged` (quem, quando, snapshot).
- [x] Testes (14): estados, agregados, filtros, pesquisa, merge. Dev: perfil com 133 chamadas em 33 ms.

### Fase 2 — Frontend ✅
- [x] `/contacts/:id` passa a ser o perfil: cabeçalho (todos os números, 1.º/último contacto), resumo, separadores Histórico (filtros, paginação, Excel) / Tipificações (donut, tabela com %, linha temporal) / Notas / Ficha clínica (se licenciada).
- [x] Edição de nome e número principal, números extra (adicionar/remover) e "Unir duplicado" (supervisor/admin/owner; Leitor só consulta).
- [x] "Ver perfil completo" no screen pop; nome do contacto leva ao perfil nas Chamadas, no detalhe da chamada e na lista de chamadas dos Relatórios.
- [x] Testado em dev: merge real (chamada + nota movidas, número do duplicado como extra, auditoria), pesquisa pelo número antigo, ecrã de telemóvel.

### Pendente / a validar
- [ ] Produção: `migrate deploy` (com backup) — confirmar que o Postgres de produção tem `pg_trgm` (contrib).

## Melhoria 6/6 — Análise dos relatórios com IA (iniciada a 02/10/2026)

Fase 0 — o que já existe:
- Claude: `packages/providers/src/llm/ClaudeAdapter.ts` (@anthropic-ai/sdk 0.30,
  `claude-sonnet-4-6`, tool_use forçado), chave em `SystemSetting`/`.env` via
  `resolveProviderConfig` (decorado em `fastify.providerConfig`), stub com
  `AI_STUB_MODE` ou sem chave. Só é usado nas chamadas de voz. **Tokens e custo
  não são gravados em lado nenhum** (só `llmMs` por turno).
- Relatórios (melhoria 1): Resumo (`buildOverview`: tiles com valor/anterior/
  variação, donuts por grupo/estado/tipificação, série diária) e Atendimento
  (`AttendanceReport`: KPIs do tenant e da selecção, por agente/grupo com
  `vsTenant`, motivos de recusa, tipificações, por dia). Filtros: período,
  extensão, grupo, tipificação. O Atendimento não calcula período anterior.
- Exportação: `overview.xlsx`, `overview.pdf` (pdfkit), `attendance/export` (xlsx).
- Permissões dos relatórios: só a feature `reports`; o supervisor hoje vê tudo.
- Notificações: não há in-app (o sino do cabeçalho é decorativo) nem email da
  plataforma — o nodemailer só serve o canal de email de cada inbox (SMTP do
  cliente). SMS via Futurix por tenant. BullMQ: workers só em `apps/worker`,
  que não tem os serviços de relatórios (vivem na API).

Decisões validadas: botão "Analisar com IA" abre o separador "Análise IA" nos
Relatórios e a análise entra nas exportações (Excel: folha "Análise IA"; PDF:
página própria). Sem email nem relatórios agendados (não pedidos).

### Fase 1 — Backend ✅
- [x] Migração `20261004120000_report_analysis`: `ReportAnalysis` (filtros, hash dos dados, prompt, modelo, resultado, tokens, custo) + `Tenant.aiReportDailyLimit` (20) e `aiReportAgentNames` (não).
- [x] `ClaudeAdapter.structured()` (mesma chave/config; timeout 60 s); modelo `AI_REPORT_MODEL` (por omissão `claude-sonnet-4-6`).
- [x] `services/reportAnalysis.service.ts`: resumo agregado sem dados pessoais (agentes pela extensão salvo permissão), comparações e sinais pré-calculados, prompt versionado `report-analysis/v1`, JSON validado (zod), cache filtros+dados, limite diário, custo em micro-USD, modo de teste sem chave.
- [x] Rotas `GET/POST /tenant/reports/analysis`, `PUT /tenant/reports/analysis/settings`; owner/admin tudo, supervisor só os seus grupos/agentes.
- [x] Exportações (`overview.xlsx`, `overview.pdf`, `attendance/export`) juntam a última análise dos mesmos filtros (nunca chamam a IA).
- [x] Testes (17): resumo, JSON, cache, limite, erros/timeout, exportação.
