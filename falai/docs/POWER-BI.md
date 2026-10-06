# Falaí — Ligar o Power BI

> Para entregar ao cliente. Os dados do centro de atendimento (chamadas,
> conversas, tickets, satisfação e qualidade) saem da API do Falaí em JSON, uma
> linha por registo, prontos para o Power BI.

## 1. Criar a chave

No CRM: **Developers → Chaves de API → Nova chave**, com a permissão
**Ler relatórios (Power BI / BI)** (`reports:read`). Esta chave só lê — não
cria nem altera nada. Copie-a: só é mostrada uma vez.

Recomendado: em "Origens permitidas", limite a chave ao IP de onde corre o
Power BI (ou o gateway).

## 2. Ligar no Power BI Desktop

1. **Obter dados → Web → Avançado**
2. Partes do URL: `https://<o-seu-servidor>/v1/reports/calls?from=2026-01-01&to=2026-12-31&limit=50000`
3. Cabeçalho do pedido HTTP: `Authorization` = `Bearer <a sua chave>`
4. No editor do Power Query: abrir `data` → **Para tabela** → expandir as colunas.

Repita para cada tabela de que precisar.

## 3. Tabelas

| URL | Uma linha por | Campos principais |
|---|---|---|
| `/v1/reports/calls` | chamada | direcção, estado, números, cliente, grupo, agente, tipificação, espera (s), conversa (s), atendida, custo, ticket |
| `/v1/reports/conversations` | conversa | canal, caixa, estado, responsável, mensagens, 1.ª resposta (s), resolvida em, ticket |
| `/v1/reports/tickets` | ticket | número, estado, prioridade, nível, origem, responsável, equipa, categoria, prazo, resolução (s), reaberturas |
| `/v1/reports/csat` | resposta de satisfação | canal, nota (1–5), agente, grupo, chamada/conversa/ticket |
| `/v1/reports/qa` | avaliação de qualidade | agente, avaliador, formulário, score, eliminatório, estado |
| `/v1/reports/consolidated` | (painel) | totais, SLA, CSAT, QA, contactos por canal e série por `bucket=day\|week\|month` |

Parâmetros comuns:

- `from`, `to` — datas `AAAA-MM-DD`. Por omissão, os últimos 30 dias. Máximo 366 dias por pedido.
- `limit` — até 50 000 linhas por pedido (por omissão 10 000).
- `offset` — para buscar a página seguinte se houver mais linhas do que o `limit`.

Datas em ISO 8601 (UTC) e durações em segundos.

## 4. Actualização automática

No Power BI Service, a actualização agendada funciona com a mesma ligação Web.
Para períodos móveis, use parâmetros do Power Query em `from`/`to` (ex.: hoje
menos 90 dias).

## 5. Erros comuns

| Resposta | Causa |
|---|---|
| 401 | Chave em falta ou errada no cabeçalho `Authorization` |
| 403 | A chave não tem `reports:read`, ou a funcionalidade Relatórios está desligada para a conta |
| 400 | Datas mal escritas ou período maior do que 366 dias |
| 429 | Demasiados pedidos seguidos — espaçar as actualizações |
