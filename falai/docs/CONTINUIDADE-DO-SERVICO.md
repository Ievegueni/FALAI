# Falaí — Continuidade do serviço

> Documento para entregar ao cliente (e para a equipa de operação da Comunica).
> Descreve o que acontece quando uma peça falha, como somos avisados, como se
> recupera, e a política de cópias de segurança.
>
> Os campos `[a preencher]` dependem do contrato e da infra-estrutura de cada
> instalação — acordar com o cliente antes de entregar.

---

## 1. De que depende o serviço

| Peça | Para quê | Quem a opera |
|---|---|---|
| Servidor da plataforma (API, CRM, backoffice) | tudo o que se vê e se faz no Falaí | Comunica |
| Base de dados (PostgreSQL) | contactos, chamadas, tickets, relatórios | Comunica |
| Filas (Redis) | webhooks, importações, sincronização com o Freshdesk | Comunica |
| Motor de telefonia (Asterisk) | chamadas de entrada e saída, gravação, IVR | Comunica |
| Operadora de voz (ANGOVOIP) | ligação à rede telefónica e números | ANGOVOIP |
| Fornecedores de IA (modelo, voz, transcrição) | agentes de IA, resumos, análise | terceiros |
| SMS (Futurix), WhatsApp (Meta), email | canais de mensagem | terceiros / cliente |
| Freshdesk do cliente (se ligado) | tickets | cliente |

## 2. Como sabemos que algo falhou

- **Vigilância interna**: a cada minuto a plataforma verifica a base de dados,
  as filas, o motor de telefonia, o registo na operadora e os peerings de cada
  cliente. Uma falha só conta à 2.ª verificação seguida (uma falha isolada não
  alarma); a recuperação conta logo.
- Quando um componente cai ou recupera:
  - fica registado no **backoffice → Saúde** (operador da Comunica);
  - aparece uma **faixa de aviso no CRM** de todos os utilizadores do cliente;
  - sai um **webhook `platform.status`** para o sistema do cliente, se o tiver
    configurado (para levar o aviso ao email, Teams, etc.).
- **Vigilância externa** (obrigatória): a plataforma não consegue avisar que
  ela própria caiu. Um monitor externo (ex.: UptimeRobot, Better Stack) deve
  pedir `GET https://<api>/status` a cada minuto e alertar a Comunica se não
  responder `200`. Responde `503` quando algum componente está em baixo.
- Alertas operacionais (espera elevada, sem agentes, SLA) são outra coisa — ver
  Supervisão → Alertas.

## 3. O que acontece em cada falha

| Falha | O que o cliente vê | O que a plataforma faz sozinha | O que fazemos |
|---|---|---|---|
| **Operadora (ANGOVOIP)** sem registo ou em baixo | chamadas de/para fora falham; faixa no CRM | o motor tenta voltar a registar-se continuamente | contactar a ANGOVOIP; confirmar recuperação no backoffice |
| **Motor de telefonia** (Asterisk) | chamadas falham; faixa no CRM | a API volta a ligar-se ao motor 3 s depois de ele voltar; chamadas penduradas são fechadas pela limpeza periódica | reiniciar o contentor (`docker compose restart`) e verificar o registo |
| **Base de dados** | CRM com erros ao gravar; faixa no CRM | — | ver §5; se for perda de dados, restaurar o último backup |
| **Filas (Redis)** | webhooks, importações e sincronização com o Freshdesk atrasam | os trabalhos retomam quando volta; nada se perde do que já estava na base de dados | reiniciar o Redis |
| **Servidor inteiro** | Falaí inacessível | — | monitor externo alerta; reiniciar ou reconstruir (§5) |
| **IA** (fornecedor em baixo) | agentes de IA sem resposta | a IA dos canais de texto passa a conversa para humano; nas chamadas ouve-se a frase de recurso | acompanhar o fornecedor |
| **SMS / WhatsApp / email** | mensagens não saem | ficam com erro registado; WhatsApp tem pool Active/Standby | acompanhar o fornecedor |
| **Freshdesk do cliente** | tickets continuam a funcionar no Falaí | grava-se no Falaí e a fila envia quando o Freshdesk voltar (novas tentativas automáticas); a sincronização de 5 em 5 min apanha o resto | ver o erro em Tickets → Integração Freshdesk |

**Durante uma falha de telefonia**, a operação do cliente pode continuar no que
não depende de voz: tickets, conversas de texto, consulta de histórico.
Procedimento recomendado ao cliente: `[a preencher — ex.: número de recurso
para desvio das chamadas na operadora, mensagem nas redes sociais]`.

## 4. Cópias de segurança

- **Base de dados**: `infra/backup/backup.sh` — exportação completa diária
  (`pg_dump` em formato comprimido, com verificação SHA-256), guardada
  `[a preencher: 14]` dias e copiada para fora do servidor (`OFFSITE_CMD`).
- **Ficheiros** (gravações, anexos): cópia espelho diária pelo mesmo script
  (`FILES_DIRS`).
- **Chaves** (`ENCRYPTION_KEY`, `JWT_SECRET` do `.env`): guardadas à parte, num
  cofre. **Sem a `ENCRYPTION_KEY` as credenciais guardadas (PBX, SMS, Freshdesk,
  modelos) ficam irrecuperáveis** — o backup da base de dados sozinho não chega.
- **Teste de restauro**: `infra/backup/restore-test.sh` restaura o último backup
  num servidor de base de dados temporário, à parte, e confirma o conteúdo. Fazer
  **pelo menos uma vez por mês** e registar a data e o resultado em §7.

Agendamento (cron, no servidor):

```bash
30 2 * * *  FILES_DIRS="/opt/falai/recordings /opt/falai/apps/api/uploads" OFFSITE_CMD='rclone copy "$1" remoto:falai' /opt/falai/infra/backup/backup.sh >> /var/log/falai-backup.log 2>&1
0 4 1 * *   /opt/falai/infra/backup/restore-test.sh >> /var/log/falai-restore-test.log 2>&1
```

**Objectivos** (a acordar com o cliente):

| | Valor actual | Nota |
|---|---|---|
| Perda máxima de dados (RPO) | até 24 h (backup diário) | baixar com backups mais frequentes ou arquivo contínuo do PostgreSQL (WAL) |
| Tempo de reposição (RTO) | `[a preencher]` | o restauro da base de dados em si é rápido (segundos a minutos); o tempo real é o de pôr um servidor novo de pé — ver §5 |

## 5. Recuperação

**Reiniciar um serviço** (falha pontual):

```bash
pm2 restart falai-api            # API
docker compose restart           # PostgreSQL / Redis
docker compose -f infra/asterisk/docker-compose.yml restart   # motor de telefonia
```

**Repor a base de dados a partir de um backup** (perda ou corrupção de dados):

1. Parar a API (`pm2 stop falai-api`) para ninguém escrever durante o restauro.
2. Restaurar: `docker exec -i falai_postgres pg_restore -U falai -d falai --clean --if-exists --no-owner < falai_AAAA-MM-DD_HHMM.dump`
3. Arrancar a API e confirmar `GET /status` = 200 e o backoffice → Saúde.
4. Dados entre o backup e a falha perdem-se (ver RPO). Os tickets que estavam no
   Freshdesk voltam pela sincronização.

**Servidor novo** (perda do servidor): seguir o `DEPLOY.md` (instalação), repor
o `.env` a partir do cofre, restaurar o último backup e os ficheiros, apontar o
DNS e o registo SIP para o servidor novo.

## 6. Redundância

Hoje cada instalação corre **num só servidor** — não há redundância automática.
O que protege o serviço é a vigilância, os backups e a capacidade de reposição.

Opções, se o cliente precisar de mais disponibilidade (com custo):

- base de dados gerida com réplica e cópias contínuas;
- segunda instância da API atrás de um balanceador (a plataforma está preparada
  para funcionar em mais do que uma instância, com notas no código onde é preciso
  partilhar estado);
- segunda conta/trunk SIP numa operadora alternativa, para continuar a fazer e
  receber chamadas se a principal cair.

## 7. Registo de testes e incidentes

| Data | Tipo (teste de restauro / incidente) | Resultado / impacto | Quem |
|---|---|---|---|
| `[a preencher]` | | | |

## 8. Contactos

| Quem | Para quê | Contacto |
|---|---|---|
| Comunica — suporte | incidentes na plataforma | `[a preencher]` |
| ANGOVOIP | operadora de voz | `[a preencher]` |
| Responsável do cliente | decisões durante um incidente | `[a preencher]` |
