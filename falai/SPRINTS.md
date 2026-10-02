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

### Fase 3 — KPIs no backend
- [ ] Serviço de KPIs (TMA, TME, tempo de resposta, perdidas, recusadas, motivos).
- [ ] Endpoints `/tenant/reports/attendance*` com período, agente, grupo e paginação.
- [ ] Comparação com a média do tenant; exportação CSV e Excel.
- [ ] Testes de cada KPI.

### Fase 4 — Aba Relatórios
- [ ] Separadores: Resumo (actual), Atendimento, Por agente, Por grupo, Recusas, Chamadas.
- [ ] Filtros comuns: hoje/semana/mês/intervalo, agente, grupo.
- [ ] Exportação CSV/Excel.
