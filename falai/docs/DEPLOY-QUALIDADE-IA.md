# Deploy na VPS — Auditor, auditoria com IA e fichas de recolha

> Guia passo a passo para pôr na VPS o commit `80992f5` (ramo `feat/tickets`).
> O guia geral continua a ser o `DEPLOY.md`. Este só cobre o que muda nesta versão.
> Está escrito para a instalação do `DEPLOY.md`: repositório em `/opt/FALAI`,
> Postgres no contentor `falai_postgres`, serviços `falai-api` e `falai-worker`.

---

## 0. Antes de começar — ler isto

- **O ramo é `feat/tickets`, não o `main`.** O `feat/tickets` está 92 commits à frente
  do `main` e inclui todo o centro de atendimento (tickets, fila, SLA, satisfação…).
  Se a VPS ainda corre o `main`, este deploy leva **tudo isso** de uma vez, com
  as migrações correspondentes.
- **Produção tem clientes reais.** Backup primeiro, `migrate deploy` depois, e nunca
  `migrate dev` nem `db push` na VPS.
- Todas as migrações desta versão são **só aditivas**: não apagam nem alteram dados.
- Tempo estimado: 20–30 minutos, mais o teste com o trunk.

---

## 1. Backup da base de dados (obrigatório)

```bash
sudo mkdir -p /opt/backups
docker exec falai_postgres pg_dump -U falai falai | gzip > /opt/backups/falai_antes_qualidade_$(date +%F_%H%M).sql.gz
ls -lh /opt/backups/ | tail -3        # confirmar que o ficheiro tem tamanho (não 0 bytes)
```

Guarda também uma cópia do `.env`:

```bash
cp /opt/FALAI/falai/.env /opt/backups/env_$(date +%F_%H%M).bak
```

---

## 2. Trazer o código

```bash
cd /opt/FALAI/falai
git status                     # tem de estar limpo; se houver alterações locais, parar e ver o que são
git fetch origin
git checkout feat/tickets
git pull origin feat/tickets
git log --oneline -1           # esperado: 80992f5 feat(qualidade): perfil de auditor, ... (ou mais recente)
```

---

## 3. Ver que migrações vão correr (antes de as aplicar)

```bash
pnpm install --frozen-lockfile
pnpm db:generate
cd packages/db && npx prisma migrate status; cd ../..
```

Entre as pendentes têm de aparecer, no mínimo:

- `20261116120000_auditor_qa_ai_contact_forms`
- `20261116180000_qa_forms_improvements`

Se a VPS vinha do `main`, aparecem também as do centro de atendimento (por exemplo
`20261013170000_call_queue_callback`). Isso é normal.

> Se o `migrate status` disser **"drift"** ou falar em migrações que falharam, **parar
> aqui** e não aplicar nada: a BD de produção está diferente do esperado.

---

## 4. Aplicar as migrações e compilar

```bash
pnpm db:migrate:prod           # prisma migrate deploy
pnpm build
```

Confirmar que as colunas novas existem:

```bash
docker exec falai_postgres psql -U falai -d falai -c '\d "ContactForm"' | head -15
docker exec falai_postgres psql -U falai -d falai -tAc \
  "select enum_range(null::\"TenantRole\")"     # tem de incluir AUDITOR
```

---

## 5. `.env` — o modelo do Claude

A auditoria e a análise de relatórios usam `AI_REPORT_MODEL`. Por omissão passou a ser
`claude-sonnet-5`.

```bash
grep AI_REPORT_MODEL /opt/FALAI/falai/.env
```

- Se **não aparecer nada**, está bem: fica o Sonnet 5.
- Se aparecer `AI_REPORT_MODEL=claude-sonnet-4-6` (ou outro), apagar a linha ou mudá-la
  para `AI_REPORT_MODEL=claude-sonnet-5`.

---

## 6. Gravações — sem gravação não há auditoria

A IA trabalha sobre o ficheiro gravado. O Asterisk escreve as gravações em
`infra/asterisk/recordings` (montado em `/var/spool/asterisk/recording` dentro do
contentor) e a API tem de as conseguir ler.

```bash
ls -la /opt/FALAI/falai/infra/asterisk/recordings | head
```

- A pasta tem de existir, e o utilizador que corre o `falai-api` tem de ter permissão
  de **leitura** sobre ela e sobre os ficheiros. O Asterisk escreve com o seu próprio
  utilizador: se a API não conseguir ler, a auditoria salta com "Gravação indisponível".

---

## 7. Reiniciar os serviços

```bash
sudo systemctl restart falai-api falai-worker
sudo systemctl status falai-api --no-pager | head -5
curl -s localhost:3000/health; echo
sudo systemctl reload nginx    # frontends novos já em dist/
```

> As chaves dos provedores e o modo de teste da IA só são lidos **quando a API arranca**. Se
> forem alterados no backoffice (passo 8), é preciso reiniciar o `falai-api` outra vez.

---

## 8. Backoffice (Comunica)

Tudo em **Configurações → Provedores & Integrações**:

1. **Deepgram** e **Anthropic**: as duas **API Key** preenchidas.
2. **IA em uso agora**: desligar o interruptor **Modo de teste**. Tem de passar a mostrar
   a IA real. Depois de mudar 1 ou 2, reiniciar a API: botão de reiniciar na mesma página
   (só SUPERADMIN) ou `sudo systemctl restart falai-api`.
3. **Pasta das gravações** = `/opt/FALAI/falai/infra/asterisk/recordings`.

Em **Tenants → [o cliente do teste]**:

4. - funcionalidades **Qualidade (QA)** e **Webphone** ligadas;
   - em **Gravação de chamadas**: gravação ligada (e o aviso, se o cliente o quiser);
   - **Auditoria IA de chamadas (Kz/min):** pôr `0` durante o teste; definir o preço
     real depois (custo de referência ≈ 0,01 USD por minuto de chamada).
   - Se for preciso, criar já aqui o utilizador com o papel **Auditor**.

---

## 9. CRM (cliente) — preparar o teste

1. **Equipa:** criar o utilizador **Auditor** (se não foi criado no backoffice) e
   confirmar que o agente que vai atender tem **extensão** associada.
2. **Supervisão → Fichas:** criar uma ficha (ex.: Nome, NIF, Província, "Tem empresa?" →
   "Nome da empresa") e marcar o **grupo** que vai atender a chamada.
3. **Qualidade → Grelhas:** criar uma grelha com pelo menos um critério sim/não, um em
   escala 1–5 e um **"Automático: ficha preenchida"**.
4. **Qualidade → Auditoria IA:**
   - grelha usada pela IA = a do passo 3;
   - chamadas auditadas automaticamente = **100 %** (só para o teste);
   - palavras proibidas (opcional), por exemplo `não é comigo`;
   - alerta de 3 avaliações seguidas (opcional), por exemplo `70`.

---

## 10. Teste com o trunk activo

1. Ligar de um telemóvel para o número do cliente. O agente atende no **webphone**.
2. A **ficha abre sozinha** no painel do cliente. Preencher e **Gravar ficha**.
3. Falar 1–2 minutos e desligar.
4. Esperar ~1 minuto (fecho da gravação, transcrição e Claude) e acompanhar os logs:

   ```bash
   sudo journalctl -u falai-api -f | grep -E "call_recording|qa_ai"
   ```

   | Log | Significa |
   |---|---|
   | `call_recording.saved` | a gravação ficou ligada à chamada |
   | `qa_ai.drafted` | rascunho criado ✅ |
   | `qa_ai.skipped` | não auditou — o motivo vem no log (ver tabela abaixo) |

5. Entrar com o **Auditor** → **Qualidade → Por rever**: o rascunho tem de lá estar.
   Abrir e confirmar: gravação a tocar, transcrição clicável, ficha, métricas, justificações
   por critério e o critério automático em **Sim**. Corrigir se for preciso e **Submeter**.
6. Entrar com o **agente** → **Qualidade**: a avaliação aparece só **depois** de submetida.

### Se o rascunho não aparecer

| Motivo no log / erro | O que fazer |
|---|---|
| `IA em modo de teste` | passo 8.2, depois reiniciar a API |
| `Esta chamada não tem gravação` | passo 8.4 (gravação ligada) e 8.3 (pasta) |
| `Gravação indisponível` | caminho errado no 8.3 ou falta de permissão de leitura (passo 6) |
| `não foi atendida por um agente com utilizador` | o agente não tem extensão associada no CRM |
| `Saldo insuficiente` | carregar saldo ou pôr o preço a 0 |
| `A gravação não tem fala` | gravação vazia: confirmar áudio nos dois sentidos |
| Nenhum log `qa_ai` | amostra a 0 % ou sem grelha escolhida (passo 9.4) |

Também dá para auditar à mão: abrir a chamada em **Chamadas** → **Auditar com IA**.

---

## 11. Depois do teste

- Baixar a amostra automática de 100 % para o valor pretendido (por exemplo 20–30 %).
- Definir o preço por minuto no backoffice (passo 8.4).
- Confirmar o débito na **Carteira** do cliente (linha "Auditoria IA"), se o preço > 0.

---

## 12. Voltar atrás (se algo correr mal)

As migrações são aditivas, por isso o código anterior funciona com a BD nova. Para voltar
**só ao código**:

```bash
cd /opt/FALAI/falai
git checkout <commit ou ramo anterior>
pnpm install --frozen-lockfile && pnpm db:generate && pnpm build
sudo systemctl restart falai-api falai-worker && sudo systemctl reload nginx
```

Restaurar a BD a partir do backup do passo 1 **só** se houver dados estragados. Isso apaga
o que entrou depois do backup:

```bash
gunzip -c /opt/backups/falai_antes_qualidade_AAAA-MM-DD_HHMM.sql.gz | docker exec -i falai_postgres psql -U falai falai
```
