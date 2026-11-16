# Deploy na VPS — Segurança do login

> Guia para pôr na VPS as melhorias de segurança do login (ramo `feat/tickets`).
> O guia geral continua a ser o `DEPLOY.md`. Este só cobre o que muda nesta versão.
> Está escrito para a instalação do `DEPLOY.md`: repositório em `/opt/FALAI`,
> Postgres no contentor `falai_postgres`, serviços `falai-api` e `falai-worker`.

---

## 0. O que muda (ler antes, e avisar os clientes)

| Mudança | Quem sente |
|---|---|
| **2FA obrigatória** para todos os admins do backoffice e para o **dono (OWNER)** de cada cliente. Quem ainda não a tem vê um código QR no próximo login e só entra depois de a activar. | Comunica e o dono de cada cliente |
| Conta **bloqueada 15 minutos** após 5 passwords erradas seguidas (conta por email, venha de que IP vier). | Todos |
| Passwords novas: mínimo 8 caracteres, não podem ser só números, nem das mais comuns (`12345678`, `falai2026`, `angola123`…). As passwords actuais continuam a funcionar. | Quem cria ou muda passwords |
| Mudar ou redefinir a password **termina as sessões abertas** dessa pessoa. | Todos |
| No CRM, **Definições → Sessões → Terminar sessão em todos os dispositivos**. | Todos |
| No backoffice, **Tenants → [cliente] → Utilizadores → Repor 2FA** para quem perdeu o telemóvel. | Comunica |
| O dono da conta já não pode desligar a 2FA. | OWNER |
| Registo self-service limitado a 5 por hora por IP. | — |
| Os segredos da 2FA passam a estar cifrados na BD. Os existentes são cifrados sozinhos quando a API arranca. | — |

**Antes do deploy:** cada pessoa da Comunica com acesso ao backoffice precisa de ter
uma app de autenticação no telemóvel (Google Authenticator, Microsoft Authenticator…).
Avisar os donos de conta dos clientes que no próximo login lhes vai ser pedida a 2FA.

As sessões abertas **não caem** com o deploy: só pedem a 2FA no próximo login.

---

## 1. Backup da base de dados (obrigatório)

```bash
sudo mkdir -p /opt/backups
docker exec falai_postgres pg_dump -U falai falai | gzip > /opt/backups/falai_antes_seg_login_$(date +%F_%H%M).sql.gz
ls -lh /opt/backups/ | tail -3        # confirmar que o ficheiro tem tamanho (não 0 bytes)
```

---

## 2. Trazer o código

```bash
cd /opt/FALAI/falai
git status                     # tem de estar limpo
git pull origin feat/tickets
```

---

## 3. Migração (só aditiva)

```bash
pnpm install --frozen-lockfile
pnpm db:generate
cd packages/db && npx prisma migrate status; cd ../..
```

Tem de aparecer pendente `20261117090000_login_security`. Acrescenta uma coluna
`tokenVersion` (inteiro, 0 por omissão) a `TenantUser` e `AdminUser`. Não apaga nada.

> Se o `migrate status` disser **"drift"** ou falar em migrações falhadas, **parar aqui**.

```bash
pnpm db:migrate:prod           # prisma migrate deploy
pnpm build
```

---

## 4. Reiniciar

```bash
sudo systemctl restart falai-api falai-worker
curl -s localhost:3000/health; echo
sudo systemctl reload nginx
sudo journalctl -u falai-api --since "2 min ago" | grep auth.totp
```

Se havia utilizadores com 2FA, aparece `auth.totp_secrets_encrypted` com o número de
segredos cifrados. Confirmar que já não sobra nenhum em claro (tem de dar `0` e `0`):

```bash
docker exec falai_postgres psql -U falai -d falai -tAc \
  "select count(*) from \"TenantUser\" where \"twoFaSecret\" ~ '^[A-Z2-7]+=*\$'; select count(*) from \"AdminUser\" where \"twoFaSecret\" ~ '^[A-Z2-7]+=*\$';"
```

> A cifra usa a `ENCRYPTION_KEY` do `.env`, a mesma das chaves dos provedores.
> **Nunca mudar esta chave** depois disto: a 2FA de toda a gente deixava de funcionar.

---

## 5. Cabeçalhos de segurança no nginx

Ver `DEPLOY.md` → secção 8 → **Cabeçalhos de segurança**. Começar em modo
`Report-Only` e só passar a bloquear depois de uns dias sem avisos na consola.

---

## 6. Teste rápido

1. **Backoffice:** sair e entrar. Aparece o QR → ler com a app → código → entra.
2. Sair e entrar outra vez: agora só pede o código.
3. **CRM** com o dono de um cliente de teste: o mesmo (QR no primeiro login).
4. Com um agente (não OWNER) sem 2FA: entra só com a password, como antes.
5. 5 passwords erradas seguidas → *"Demasiadas tentativas falhadas. A conta fica bloqueada 15 minutos."*

---

## Recuperar acesso

**Cliente perdeu o telemóvel:** backoffice → Tenants → cliente → Utilizadores → **Repor 2FA**.
Se for o dono, volta a ver o QR no próximo login.

**Conta bloqueada por passwords erradas e não dá para esperar 15 minutos:**

```bash
docker exec falai_redis redis-cli del "login:fail:tenant:email@do.cliente"   # CRM
docker exec falai_redis redis-cli del "login:fail:admin:email@comunica.ao"   # backoffice
```

(Ajustar o nome do contentor do Redis ao da instalação: `docker ps`.)

**Admin do backoffice perdeu o telemóvel** (não há outro admin que o resolva pela interface):

```bash
docker exec falai_postgres psql -U falai -d falai -c \
  "update \"AdminUser\" set \"twoFaSecret\" = null, \"tokenVersion\" = \"tokenVersion\" + 1 where email = 'email@comunica.ao';"
```

No login seguinte volta a ver o QR.
