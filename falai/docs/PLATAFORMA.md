# Falaí — Descrição Completa da Plataforma

## O que é o Falaí

O Falaí é uma plataforma SaaS multi-tenant de comunicação por voz, desenvolvida pela Comunica para o mercado angolano. Combina um motor de chamadas com inteligência artificial e um CRM de chamadas, oferecendo dois produtos distintos que podem ser comercializados de forma independente.

---

## Dois Produtos

### 1. Voice AI — Operador com IA

O cliente usa a infraestrutura de telefonia da Comunica (PBX Yeastar gerido). As chamadas são atendidas ou iniciadas por agentes de IA configuráveis. A faturação é por minuto de chamada consumido.

**Casos de uso:** call centres automatizados, atendimento fora de horas, campanhas de voz com IA, qualificação de leads.

### 2. CRM BYO-PBX — CRM com PBX Próprio

O cliente liga o seu próprio PBX Yeastar à plataforma (bring-your-own-PBX). O Falaí sincroniza o histórico de chamadas (CDR) do PBX do cliente e oferece um painel de CRM. A faturação é uma mensalidade fixa.

**Casos de uso:** empresas que já têm Yeastar e querem um CRM de chamadas, visibilidade de CDR, click-to-call directo.

---

## Arquitectura Técnica

```
monorepo (pnpm workspaces)
├── apps/
│   ├── api         — Fastify REST API (Node.js + TypeScript)
│   ├── crm         — Frontend do cliente (React + Vite + Tailwind)
│   ├── backoffice  — Frontend da Comunica (React + Vite + Tailwind)
│   └── worker      — Workers assíncronos (BullMQ)
└── packages/
    ├── db          — Prisma schema + client (PostgreSQL)
    ├── providers   — Adaptador Yeastar e interface TelephonyProvider
    └── shared      — Tipos e eventos partilhados
```

**Infraestrutura:** PostgreSQL · Redis (cache de tokens, cache de áudio, filas BullMQ) · Yeastar P-Series Open API

---

## Motor de Chamadas com IA

O `CallEngineService` gere o ciclo de vida completo de uma chamada com agente de IA:

1. **Registo** — associa um `providerCallId` Yeastar a uma sessão interna com estado.
2. **DIALING → RINGING → IN_PROGRESS** — transições de estado via eventos do PBX.
3. **VAD (Voice Activity Detection)** — `VadDetector` detecta quando o humano começa e para de falar para delimitar turnos.
4. **Processamento de turno** — `TurnProcessor` orquestra STT (transcrição de voz) → LLM (resposta do agente) → TTS (síntese de voz) → reprodução no PBX.
5. **Histórico de conversa** — cada turno (AGENT / HUMAN / SYSTEM) é guardado em `CallTurn` com timestamps de latência (STT, LLM, TTS).
6. **Límites de tempo** — temporizador máximo de chamada (`maxCallSeconds`) e timeout de silêncio.
7. **Escalação** — quando o agente decide escalar, transfere a chamada para um número humano.
8. **Fim de chamada** — liquida o custo exacto, liberta a reserva de saldo, dispara webhook.

**Cache de áudio (`AudioCache`)** — reutiliza áudio TTS já gerado para frases repetidas, reduzindo latência e custo.

---

## Agentes de IA

Um agente é a configuração completa de um assistente de voz:

| Campo | Descrição |
|---|---|
| `systemPrompt` | Instruções em linguagem natural que definem o comportamento do agente |
| `ttsVoiceId` | Voz TTS a usar nas respostas |
| `sttModel` | Modelo de transcrição de voz |
| `language` | Idioma (padrão `pt-PT`) |
| `maxCallSeconds` | Duração máxima de uma chamada (segundos) |
| `maxTurnSeconds` | Timeout de silêncio por turno |
| `escalationNumber` | Número para onde transferir se o agente decidir escalar |
| `escalationRules` | Regras que disparam escalação (JSON) |
| `variablesSchema` | Schema das variáveis dinâmicas injectadas em cada chamada |

**Ciclo de vida do agente:**

```
DRAFT → PENDING_REVIEW → ACTIVE
                       ↘ BLOCKED (moderação recusa)
ACTIVE → PAUSED (pelo cliente)
```

O backoffice da Comunica aprova ou recusa agentes antes de poderem fazer chamadas. Cada alteração ao `systemPrompt` gera uma versão em `AgentVersion`.

**Simulador** — o CRM tem um simulador de conversa que permite testar o agente por texto antes de o activar.

---

## Chamadas

### Estados possíveis

```
QUEUED → DIALING → RINGING → IN_PROGRESS → COMPLETED
                                          ↘ ESCALATED
                            ↘ NO_ANSWER
                            ↘ BUSY
                            ↘ FAILED
       → CANCELLED (cancelada antes de atender)
```

### Tipos de chamada

**Chamada com agente de IA** — inicia pelo CRM ou API, associada a um agente activo. O saldo é reservado antes do dial e liquidado após o fim.

**Chamada directa (click-to-call)** — sem IA. O operador selecciona uma extensão de origem e um número de destino; o PBX toca primeiro a extensão do operador e depois liga ao destino. A chamada é monitorizada por polling para detectar quando qualquer parte desliga.

**Chamada de campanha** — iniciada automaticamente pelo `CampaignDispatcher`, associada a um contacto e a uma campanha.

### Detalhes registados por chamada

- Transcrição completa turno a turno (texto, latências STT/LLM/TTS)
- Duração total e duração facturada
- Custo em cêntimos
- URL de gravação (quando disponível no PBX)
- Causa de hangup
- Variáveis dinâmicas usadas

---

## Campanhas

Uma campanha permite disparar chamadas com IA a uma lista de contactos de forma automática e controlada.

**Configuração:**
- Agente de IA a usar
- Lista de contactos (adicionados manualmente ou via import CSV)
- Janela de agendamento — horas de início/fim e dias da semana em que o dispatcher pode disparar chamadas
- Throttle por minuto — máximo de chamadas simultâneas por minuto
- Retry policy — número de tentativas e intervalo entre elas em caso de `NO_ANSWER` ou `BUSY`

**Estados da campanha:** `DRAFT → SCHEDULED → RUNNING → PAUSED → DONE / CANCELLED`

**Estados por contacto dentro de uma campanha:** `PENDING → QUEUED → IN_PROGRESS → COMPLETED / FAILED / OPTED_OUT`

O `CampaignDispatcher` corre a cada 30 segundos, verifica campanhas `RUNNING` dentro da janela horária e dispara chamadas respeitando o throttle e o saldo disponível.

---

## Contactos

- Base de dados de contactos por tenant (telefone único por tenant)
- Atributos livres em JSON (nome, empresa, qualquer campo)
- Opt-out — quando um contacto pede para não ser contactado, fica marcado com `optedOutAt` e não recebe mais chamadas de campanhas
- Import assíncrono via CSV (worker de importação, resultado devolvido via polling)

---

## Billing e Wallet

Cada tenant tem uma carteira de saldo pré-pago com as seguintes operações:

| Tipo de transacção | Descrição |
|---|---|
| `TOPUP` | Carregamento de saldo (manual ou via ProxyPay) |
| `CALL_CHARGE` | Custo liquidado após cada chamada |
| `REFUND` | Reembolso de saldo |
| `ADJUSTMENT` | Ajuste manual pelo backoffice |
| `MONTHLY_FEE` | Débito automático da mensalidade do plano CRM |

**Reserva de saldo** — antes de cada chamada IA, o custo máximo estimado é reservado atomicamente. Após a chamada, o custo real é calculado e a diferença é devolvida ou debitada.

**Limite de crédito** — o backoffice pode atribuir `creditLimitCents` que permite ao tenant ter saldo negativo até esse limite.

**ProxyPay** — integração com o gateway de pagamentos angolano ProxyPay para carregar saldo online. A referência de pagamento é gerada pela plataforma e a confirmação chega via webhook.

**Faturação mensal automática** — para planos com `monthlyFeeCents > 0`, o worker de billing cria automaticamente uma `Invoice` e debita o saldo no início de cada ciclo.

---

## Planos

Os planos definem o que um tenant pode fazer e quanto paga:

| Campo | Descrição |
|---|---|
| `productType` | `VOICE_AI` ou `CRM_BYO_PBX` |
| `aiAgentsEnabled` | Se o tenant pode criar e usar agentes de IA |
| `pricePerMinuteCents` | Custo por minuto de chamada IA |
| `monthlyFeeCents` | Mensalidade do plano (0 = sem mensalidade) |
| `includedMinutes` | Minutos incluídos no plano |
| `maxAgents` | Número máximo de agentes activos em simultâneo |
| `maxConcurrent` | Chamadas simultâneas permitidas |

---

## Webhooks

Quando uma chamada termina, a plataforma tenta entregar um evento POST ao `webhookUrl` configurado pelo tenant. O payload inclui o estado final, duração, custo e transcrição. Em caso de falha, há retry com backoff exponencial (gerido por BullMQ).

O tenant configura também um `webhookSecret` para validar a assinatura HMAC dos eventos recebidos.

---

## API Pública (v1)

Acessível com API Key (prefixo `fal_`). Permite integração com sistemas externos:

- `GET/POST /v1/agents` — listar e criar agentes
- `GET/POST /v1/calls` — histórico e iniciar chamadas
- `GET/POST /v1/campaigns` — gestão de campanhas
- `GET/POST /v1/contacts` — gestão de contactos e opt-out
- `GET /v1/wallet` — consultar saldo e transacções

---

## Multi-tenant e Controlo de Acessos

### Papéis dentro de um tenant (CRM)

| Papel | Permissões |
|---|---|
| `OWNER` | Acesso total, incluindo billing e settings |
| `ADMIN` | Acesso total excepto operações financeiras críticas |
| `MEMBER` | Chamadas, campanhas e contactos |
| `VIEWER` | Só leitura |

### Papéis do backoffice (Comunica)

| Papel | Permissões |
|---|---|
| `SUPERADMIN` | Acesso total |
| `OPERATOR` | Gestão de tenants e agentes |
| `FINANCE` | Finanças e facturas |
| `SUPPORT` | Leitura e audit log |

Todos os utilizadores (CRM e backoffice) têm suporte a autenticação de dois factores (2FA) via TOTP.

---

## Integração PBX do Cliente (BYO-PBX)

Para o produto CRM BYO-PBX, o tenant configura as credenciais do seu Yeastar:
- URL base do PBX
- Client ID e Client Secret (encriptados com AES-256-GCM)
- Extensão de saída por defeito

A plataforma:
1. Testa a ligação e marca `pbxConnected`
2. Sincroniza o CDR periodicamente via `GET /openapi/v1.0/cdr/list`
3. Expõe um URL de webhook único (`/webhooks/pbx/:token`) para que o PBX notifique eventos em tempo real
4. Lista as extensões disponíveis para o dropdown de click-to-call

---

## CRM — Interface do Cliente

Módulos disponíveis na aplicação web do cliente:

| Módulo | Funcionalidade |
|---|---|
| Dashboard | Métricas de chamadas, taxa de conclusão, custo do período |
| Agentes | Criar, editar, simular e activar agentes de IA |
| Chamadas | Histórico com transcrição, iniciar chamada com IA, click-to-call directo |
| Campanhas | Criar, gerir e acompanhar campanhas de chamadas |
| Contactos | Base de dados, opt-out, import CSV |
| Equipa | Gerir utilizadores e papéis dentro do tenant |
| Carteira | Saldo, histórico de transacções, carregamento |
| Integração PBX | Configurar e testar ligação ao PBX próprio |
| API Keys | Criar e revogar chaves de API |
| Webhook Events | Histórico de eventos entregues via webhook |
| Developers | Documentação da API e exemplos |

---

## Backoffice — Interface da Comunica

Painel de gestão interno para a equipa da Comunica:

| Módulo | Funcionalidade |
|---|---|
| Dashboard | Visão geral de tenants activos, chamadas e receita |
| Tenants | Criar, editar, suspender e fechar contas de clientes |
| Planos | Criar e gerir planos de produto |
| Chamadas | Histórico global de todas as chamadas |
| Moderação | Aprovar ou rejeitar agentes submetidos pelos clientes |
| Finanças | Transacções, facturas, ajustes de saldo |
| Configurações | Chaves de API dos provedores (Yeastar, STT, TTS, LLM), encriptadas na base de dados |
| Saúde | Estado do sistema, conectividade PBX, filas de trabalho |
| Auditoria | Log imutável de todas as acções administrativas |

---

## Auditoria

Todas as acções relevantes (criação, alteração ou eliminação de recursos, acções administrativas, login) são registadas em `AuditLog` com:
- Tipo e ID do actor (admin ou utilizador tenant)
- Tenant afectado
- Acção e recurso alvo
- Estado antes e depois (JSON diff)
- IP de origem

---

## Segurança

- Passwords com hash bcrypt
- 2FA TOTP em todos os utilizadores
- API Keys com hash SHA-256, escopos configuráveis e prefixo legível (`fal_`)
- Credenciais PBX do cliente encriptadas com AES-256-GCM
- Configurações de sistema sensíveis (chaves de provedores) encriptadas na base de dados
- Assinatura HMAC nos webhooks
- Tokens Yeastar armazenados no Redis com TTL, com refresh proactivo
- Tokens de sessão JWT com expiração curta
