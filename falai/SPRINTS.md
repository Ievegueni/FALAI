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
