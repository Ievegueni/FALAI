# Guia de Deploy — Falaí (VPS)

Guia para colocar a plataforma Falaí a correr numa VPS Linux (Ubuntu 22.04+).

---

## 1. Arquitetura

A plataforma tem **4 componentes de código** + **2 serviços de dados**:

| Componente | O que é | Porta (interna) |
|---|---|---|
| **API** (`apps/api`) | Backend Fastify — REST `/admin`, `/tenant`, `/v1` + WebSocket do motor de chamadas | `3000` |
| **Worker** (`apps/worker`) | Processos BullMQ (chamadas, billing, webhooks, import de contactos) | — |
| **CRM** (`apps/crm`) | Frontend do cliente (React/Vite, estático) | servido por nginx |
| **Backoffice** (`apps/backoffice`) | Painel de admin (React/Vite, estático) | servido por nginx |
| **PostgreSQL** | Base de dados | `5432` |
| **Redis** | Filas BullMQ + tokens/cache | `6379` |

> A API e o Worker partilham a mesma base de código e o mesmo `.env`. Correm como **dois processos** distintos.

---

## 2. Pré-requisitos na VPS

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
sudo npm install -g pnpm@9

# Docker (para Postgres + Redis) + nginx + certbot
sudo apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git
sudo systemctl enable --now docker
```

---

## 3. Clonar o repositório

```bash
cd /opt
sudo git clone git@github.com:Ievegueni/FALAI.git
sudo chown -R $USER:$USER FALAI
cd FALAI/falai        # raiz do monorepo pnpm
```

---

## 4. PostgreSQL + Redis (Docker)

Não há `docker-compose` no repo — cria este ficheiro em `falai/docker-compose.prod.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    container_name: falai_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: falai
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: falai
    ports:
      - "127.0.0.1:5432:5432"     # só acessível localmente
    volumes:
      - falai_pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7
    container_name: falai_redis
    restart: unless-stopped
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - falai_redisdata:/data

volumes:
  falai_pgdata:
  falai_redisdata:
```

Arrancar:

```bash
POSTGRES_PASSWORD='uma-password-forte' docker compose -f docker-compose.prod.yml up -d
```

> As portas estão limitadas a `127.0.0.1` — os dados **não** ficam expostos à internet. Bom.

---

## 5. Variáveis de ambiente (`.env`)

Cria `falai/.env` (a API e o worker lêem daqui). Baseia-te no `.env.example`:

```bash
# Core
DATABASE_URL=postgresql://falai:uma-password-forte@localhost:5432/falai
REDIS_URL=redis://localhost:6379
JWT_SECRET=            # >= 32 chars — gera com: openssl rand -hex 32
ENCRYPTION_KEY=        # EXACTAMENTE 32 chars — gera com: openssl rand -hex 16

# API
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
# domínios do frontend autorizados (CORS), separados por vírgula
ALLOWED_ORIGINS=https://crm.teu-dominio.com,https://admin.teu-dominio.com
# proxies em que confiamos para nos dizer o IP de origem (IP ou CIDR).
# OBRIGATÓRIO atrás de nginx se usares allowlist de IP nas chaves de API:
# sem isto, request.ip é o do nginx e as chaves restritas recusam tudo.
# NUNCA pôr um valor demasiado largo — quem estiver fora da lista pode forjar
# X-Forwarded-For e contornar a allowlist com uma chave roubada.
TRUSTED_PROXIES=127.0.0.1

# Telefonia Yeastar (podes deixar vazio e configurar depois no backoffice → Configurações)
YEASTAR_BASE_URL=
YEASTAR_CLIENT_ID=
YEASTAR_CLIENT_SECRET=
YEASTAR_STUB_MODE=false      # false = chamadas reais

# Provedores (opcionais — também configuráveis no backoffice)
DEEPGRAM_API_KEY=
ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=
AZURE_TTS_KEY=
AZURE_TTS_REGION=
PROXYPAY_API_KEY=
FUTURIX_SMS_API_KEY=
```

Gerar segredos rapidamente:

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 16)"   # 16 bytes = 32 chars hex
```

> **Importante:** guarda `ENCRYPTION_KEY` num sítio seguro. Se a perderes, os segredos encriptados na BD (credenciais de PBX, chaves de API dos provedores) ficam ilegíveis.

---

## 6. Instalar, migrar e compilar

```bash
cd /opt/FALAI/falai

pnpm install --frozen-lockfile        # instala tudo

pnpm db:generate                      # gera o Prisma Client
pnpm db:migrate:prod                  # aplica migrações (prisma migrate deploy)

pnpm build                            # compila API, worker, packages e frontends
```

---

## 7. API + Worker como serviços (systemd)

### API — `/etc/systemd/system/falai-api.service`

```ini
[Unit]
Description=Falai API
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/opt/FALAI/falai/apps/api
EnvironmentFile=/opt/FALAI/falai/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

### Worker — `/etc/systemd/system/falai-worker.service`

```ini
[Unit]
Description=Falai Worker
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/opt/FALAI/falai/apps/worker
EnvironmentFile=/opt/FALAI/falai/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

Activar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now falai-api falai-worker
sudo systemctl status falai-api --no-pager
```

> Alternativa a systemd: `pm2 start dist/index.js --name falai-api` (e `falai-worker`), depois `pm2 save && pm2 startup`.

---

## 8. Frontends + nginx (reverse proxy)

Os frontends são **estáticos** (pasta `dist`). A forma mais simples é servir cada um no seu subdomínio e o nginx faz proxy das rotas da API para `:3000`.

Como o `api.ts` usa `VITE_API_URL ?? ''` (URL relativo por omissão), se o nginx encaminhar `/admin`, `/tenant` e `/v1` para a API **no mesmo domínio**, não precisas de configurar `VITE_API_URL`. Basta compilar:

```bash
pnpm build     # gera apps/crm/dist e apps/backoffice/dist
```

### CRM — `/etc/nginx/sites-available/falai-crm`

```nginx
server {
    server_name crm.teu-dominio.com;
    root /opt/FALAI/falai/apps/crm/dist;
    index index.html;

    # SPA — todas as rotas caem no index.html
    location / { try_files $uri $uri/ /index.html; }

    # API do cliente
    location /tenant { proxy_pass http://127.0.0.1:3000; include proxy_params; }
    location /v1     { proxy_pass http://127.0.0.1:3000; include proxy_params; }

    # WebSocket do motor de chamadas (se aplicável ao CRM)
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Sinalização SIP/WebRTC do webphone — proxy directo para o Asterisk
    # (porta interna 127.0.0.1:8089, só loopback, ver infra/asterisk/docker-compose.yml).
    # Mesmo domínio/certificado do CRM, sem listen/server{} novo.
    # RTP/ICE (áudio) NÃO passa por aqui — vai directo do browser ao Asterisk
    # nas portas 10000-10100/udp já expostas ao host.
    location /webphone-ws {
        proxy_pass http://127.0.0.1:8089;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # WS de sinalização SIP fica aberto durante toda a sessão registada
        # (não é um request/response curto) — timeout alargado.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Backoffice — `/etc/nginx/sites-available/falai-backoffice`

```nginx
server {
    server_name admin.teu-dominio.com;
    root /opt/FALAI/falai/apps/backoffice/dist;
    index index.html;

    location / { try_files $uri $uri/ /index.html; }
    location /admin { proxy_pass http://127.0.0.1:3000; include proxy_params; }
}
```

Activar + TLS:

```bash
sudo ln -s /etc/nginx/sites-available/falai-crm /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/falai-backoffice /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Certificados Let's Encrypt (configura o HTTPS automaticamente)
sudo certbot --nginx -d crm.teu-dominio.com -d admin.teu-dominio.com
```

> Confirma que os subdomínios apontam (DNS A record) para o IP da VPS antes de correr o certbot.

---

## 9. Bootstrap inicial

### Criar o primeiro admin (SUPERADMIN)

O registo do primeiro admin exige uma `BOOTSTRAP_KEY`. Define-a temporariamente no `.env`, reinicia a API e faz o pedido:

```bash
# adiciona ao .env: BOOTSTRAP_KEY=uma-chave-qualquer  e reinicia a API
curl -X POST https://admin.teu-dominio.com/admin/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"admin@teu-dominio.com","password":"uma-password-forte","bootstrapKey":"uma-chave-qualquer"}'
# depois remove a BOOTSTRAP_KEY do .env e reinicia
```

### Configurar provedores

Entra no backoffice → **Configurações** e preenche as chaves de API (Yeastar, Deepgram, Anthropic, ElevenLabs…). Ficam encriptadas na BD e aplicam-se ao reiniciar a API.

### Prompts de OTP (se usares OTP por voz)

```bash
cd /opt/FALAI/falai/apps/api
pnpm otp:prompts
```

---

## 10. Verificação

```bash
# O /health não está exposto pelo nginx — testa localmente na VPS:
curl -s http://127.0.0.1:3000/health
# esperado: {"status":"ok","providers":{"yeastar":{"ok":true,...}}}

sudo systemctl status falai-api falai-worker --no-pager
sudo journalctl -u falai-api -f          # logs em tempo real
```

---

## 11. Atualizações (deploy de novas versões)

```bash
cd /opt/FALAI/falai
git pull origin main

pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate:prod          # aplica migrações novas (seguro; nunca apaga dados)
pnpm build

sudo systemctl restart falai-api falai-worker
sudo systemctl reload nginx  # os frontends novos já estão em dist/
```

> Dica: cria um script `deploy.sh` com estes passos.

---

## 12. Backups

```bash
# Backup da base de dados (agenda no cron, ex.: diário)
docker exec falai_postgres pg_dump -U falai falai | gzip > /opt/backups/falai_$(date +%F).sql.gz

# Restauro
gunzip -c /opt/backups/falai_2026-01-01.sql.gz | docker exec -i falai_postgres psql -U falai falai
```

Faz também backup seguro do `.env` (em especial `ENCRYPTION_KEY` e `JWT_SECRET`).

---

## Checklist rápida

- [ ] Node 20 + pnpm 9 + Docker + nginx + certbot instalados
- [ ] Postgres + Redis a correr (`docker compose ... up -d`), portas em `127.0.0.1`
- [ ] `.env` com `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `ALLOWED_ORIGINS`, `TRUSTED_PROXIES`, `YEASTAR_STUB_MODE=false`
- [ ] `pnpm install && db:generate && db:migrate:prod && build`
- [ ] Serviços `falai-api` e `falai-worker` activos (systemd)
- [ ] nginx a servir CRM + Backoffice com TLS
- [ ] Primeiro admin criado e provedores configurados no backoffice
- [ ] `/health` responde `ok`
- [ ] Backups agendados
