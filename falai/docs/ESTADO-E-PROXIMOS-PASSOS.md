# Falaí — Estado do projecto e próximos passos

> **Este é o ficheiro para ler no início de cada sessão.** Diz o que está feito,
> o que falta e por onde continuar. Actualizar no fim de cada sessão.
>
> Última actualização: **29/07/2026**
> Branch actual: `docs/deploy-guide` · Último commit: `7a668e3` (módulo PBX nativo)
> **Atenção: há trabalho não commitado** (ver secção 6).

---

## 1. Em uma linha

A plataforma (API, CRM, backoffice, workers, billing, campanhas, SMS, CRM,
relatórios) está construída e a funcionar. O que falta é **telefonia real**: o
motor Asterisk já regista e já consegue sair para a rede da ANGOVOIP, mas ainda
**não foi feita uma chamada de voz real com áudio nos dois sentidos**, e a **IA
ainda não fala nem ouve numa chamada SIP**.

Duas frentes abertas, por esta ordem:
1. **Chamada de teste real** pela ANGOVOIP (bloqueada por respostas deles + NAT).
2. **`externalMedia`** — a IA a falar e a ouvir. É o único bloqueio técnico real
   entre "fazemos chamadas" e "o produto funciona".

---

## 2. Decisão de arquitectura em vigor (não reabrir)

**O Falaí é apenas um cliente SIP da ANGOVOIP.** Fechado a 28/07/2026.

- A ANGOVOIP é dona da central: numeração, DIDs, encaminhamento, IVR, filas,
  tarifação de operador. Cada tenant tem **conta SIP própria** criada por eles
  (Cenário A, confirmado pelo IT deles).
- O **host SIP é público e partilhado** (`87.238.224.117:5060/UDP`) — só mudam
  utilizador e senha por cliente.
- O Falaí é dono da **IA, CRM, campanhas, SMS e relatórios**.
- O **softphone é da ANGOVOIP** (Linkus / o que eles desenvolverem). Fora do
  nosso âmbito: nada de WebRTC, app móvel ou push.
- **Mas continuamos a precisar de motor SIP próprio** (Asterisk em Docker) —
  porque a IA precisa de terminar RTP para falar com Deepgram/ElevenLabs. Isso
  não muda com nenhuma decisão de negócio.
- O que **desapareceu do âmbito**: toda a paridade com o Yeastar (IVR, filas,
  grupos de toque, voicemail, softphone próprio). Era o plano antigo.

Documento de referência completo: `docs/AVALIACAO-MODELO-SIP-ANGOVOIP.txt`
(secções 9-C a 11 são as decisões actuais).

---

## 3. O QUE JÁ ESTÁ FEITO

### 3.1 Plataforma (Sprints 1–6 + módulos posteriores) — completo e testado

| Área | Estado |
|---|---|
| Monorepo pnpm (api, crm, backoffice, worker, db, providers, shared) | ✅ |
| Prisma + PostgreSQL + Redis + filas BullMQ | ✅ |
| Multi-tenant, auth, 2FA, roles, audit log | ✅ |
| Dois produtos: `VOICE_AI` e `CRM_BYO_PBX` (`Plan.productType`) | ✅ |
| Conversation engine (IA), agentes, prompts | ✅ |
| Campanhas — modo IA e modo `FIXED_SCRIPT` (TTS gerado 1x) | ✅ |
| Billing: modos por minuto / segundo / chamada + override por tenant | ✅ |
| ProxyPay, carteira, billing mensal | ✅ |
| API pública `/v1/*`, webhooks com retry, import async de contactos | ✅ |
| SMS (Futurix) — avulso + campanhas, credenciais/preço por tenant | ✅ |
| Chamadas de entrada: screen pop SSE + registo ao vivo | ✅ |
| Relatórios com export CSV/PDF | ✅ |
| i18n PT/EN/ZH no CRM | ✅ |
| Backoffice: planos, tenants, utilizadores do tenant, moderação, settings, API keys dos provedores (encriptadas em `SystemSetting`) | ✅ |
| Módulo Clínica (flag `clinicEnabled`, ficha em `Contact.attributes`) | ✅ |
| Guia de deploy em VPS | ✅ `DEPLOY.md` |

### 3.2 Motor de telefonia Asterisk — verificado na máquina em 28/07

- ✅ `infra/asterisk/` — Docker, transportes, RTP, ARI, AMI. Contentor
  `falai-asterisk` a correr.
- ✅ **REGISTADO na ANGOVOIP** em `87.238.224.117:5060/UDP`, conta de teste
  `878007792000`. Latência ~220–260 ms.
- ✅ Portas RTP `10000-10100/udp` e `5060` mapeadas no Docker.
- ✅ `EXTERNAL_IP=102.130.202.155` preenchido em `infra/asterisk/.env` (resolve
  a causa nº1 de "áudio só num sentido").
- ✅ API ligada ao motor por **ARI** (`TELEPHONY_ENGINE=asterisk`); a aplicação
  `falai` aparece registada no Asterisk.
- ✅ `asteriskRuntime.service` gera a config PJSIP **global** a partir da BD e
  sincroniza por AMI; `asteriskStatus.service` lê estado.
- ✅ 5 extensões (1000–1004) na config, prontas para um softphone.
- ✅ `infra/asterisk/test-call.sh <numero>` — chamada de teste pelo ARI.
- ✅ Botão de chamada de teste no backoffice já passa pelo motor activo
  (`apps/api/src/routes/admin/test-call.ts` → `fastify.telephony.dial`).
- ✅ **Saída para a rede provada**: `INVITE → 401 → INVITE autenticado → 100
  Trying → 480` para número inválido. Autenticação e INVITE aceites pelo
  operador. O caminho de saída funciona.

### 3.3 Seis bugs corrigidos em 28/07 (contexto — nenhum era conhecido antes)

1. Snapshot por tenant apagava a config dos outros → passou a **global**.
2. Três reloads em rajada anulavam-se → **espaçados 2s**, falhas registadas.
3. `dial` marcava pela extensão de origem → passa pelo **endpoint do trunk**
   (cache 30s).
4. Dialplan usava trunk inexistente `@angovoip` → API gera
   `globals-falai.conf` com `TRUNK_ENDPOINT`/`TRUNK_USER` da BD.
5. Endpoints nomeados pelo número colidiam → nomeados pelo **utilizador SIP**.
6. Health check disparava reloads do motor → só confirma que o AMI responde.

---

## 4. O QUE FALTA FAZER

### 4.1 BLOQUEADO — respostas a pedir à ANGOVOIP

Sem isto não há chamada de teste válida. **Enviar isto primeiro.**

- [ ] Formato do número a marcar: `9XXXXXXXX`, `244XXXXXXXXX` ou `+244...`?
      (configurável em `ASTERISK_DIAL_FORMAT`, sem tocar no código)
- [ ] Caller ID a apresentar nesta conta de teste (`ASTERISK_CALLER_ID`)
- [ ] A conta de teste tem saldo/permissão para chamadas reais para telemóvel?
- [ ] O IP `102.130.202.155` precisa de entrar em allowlist deles?
- [ ] Há DID atribuído a esta conta, para testar entrada? (opcional agora)
- [ ] A mesma conta SIP pode estar registada em dois sítios em simultâneo
      (softphone deles + Falaí)? **Recomendação: pedir conta SIP dedicada ao
      Falaí por cliente**, separada das pessoas — o robô nunca rouba chamadas e
      o consumo fica separado na factura deles.

### 4.2 NOSSO LADO — rede (~1 hora)

- [ ] Abrir no router `5060/udp` e `10000-10100/udp` para esta máquina.
      Nota: testar o áudio primeiro — há servidores com RTP simétrico que se
      safam sem isto. Ajustar só se falhar.

### 4.3 Chamada de teste, por esta ordem

- [ ] a) Marcar `600` no softphone (Zoiper/Linphone na extensão 1000) — teste
      de eco, valida áudio local nos dois sentidos, não gasta minutos.
- [ ] b) Chamada entre duas extensões locais — valida encaminhamento.
- [ ] c) **Chamada real para um telemóvel** — o teste verdadeiro, sai pela
      ANGOVOIP. Ouve-se dos dois lados? Atraso? Corta?
- [ ] d) Se houver DID: chamada de entrada de um telemóvel para o DID.
- [ ] e) Chamada originada pelo **Falaí** (botão do backoffice), não por um
      softphone — prova que a plataforma telefona. Código já existe; falta
      correr e confirmar.

### 4.4 `externalMedia` — a IA a falar e a ouvir  ⬅ **o bloqueio real**

Não existe nada disto ainda (`grep externalMedia` não devolve nada no código).

- [ ] Canal `externalMedia` no ARI para entregar RTP à API.
- [ ] Ligar o RTP de entrada ao **Deepgram** (transcrição em tempo real).
- [ ] Injectar o áudio da **ElevenLabs** de volta na chamada.
- [ ] Ligar ao conversation engine existente (já funciona, só falta o áudio).
- [ ] `AsteriskAdapter.uploadPrompt()` é um stub vazio — decidir se é preciso
      (o `playPrompt` já está implementado).

### 4.5 Depois disso (não perder de vista)

- [ ] **Endpoint global + conta SIP por tenant no backoffice** (secção 9-C.1 do
      AVALIACAO). Hoje cada tenant tem uma ficha de trunk inteira; passa a ser
      uma ligação global + 2-3 campos por cliente. É migração de BD — fazer
      quando a ANGOVOIP entregar as contas reais, aí já se sabe o formato.
- [ ] **Limpar a camada Yeastar de controlo de chamadas** (websocket, webhooks,
      dial — ~800 linhas). **NÃO apagar** `YeastarAdapter`+`pbxSync.service` na
      parte de **leitura de CDR**: é o que serve o produto `CRM_BYO_PBX` e a
      futura sincronização de histórico.
- [ ] **Histórico de chamadas feitas fora do Falaí** — congelado por decisão.
      Nem se apaga nem se constrói.
- [ ] Verificar que o reload automático por AMI chega sempre ao motor (foi
      corrigido, mas era um bug latente: mexer no backoffice podia não chegar).

---

## 5. Riscos assumidos

- **Dependência total da ANGOVOIP para a voz.** Mitigação barata e já em vigor:
  manter a camada `TelephonyProvider` genérica, para um dia ligar a outro
  operador sem refazer a plataforma.
- **Latência ~220–260 ms** de sinalização é aceitável para voz humana; **a
  vigiar quando a IA entrar** (soma-se ao tempo de STT+LLM+TTS).
- **A conta de teste é uma só.** O isolamento por tenant não foi provado com
  contas reais.

---

## 6. Trabalho não commitado (arrumar no início da próxima sessão)

Está tudo na árvore de trabalho, typecheck limpo, mas **sem commit**:

```
Novos:     apps/api/src/services/asteriskRuntime.service.ts
           apps/api/src/services/asteriskStatus.service.ts
           packages/providers/src/telephony/AsteriskAdapter.ts
           packages/providers/src/telephony/asteriskNaming.ts
           infra/                (Asterisk em Docker, templates, scripts)
           packages/db/prisma/migrations/20260727224114_add_telephony_engine/
Alterados: 19 ficheiros (api, backoffice, schema.prisma, providers, .env.example)
```

Sugestão: `feat(telephony): motor Asterisk como cliente SIP da ANGOVOIP`.
Estamos em `docs/deploy-guide` — criar branch própria antes de commitar.

---

## 7. Comandos úteis

```bash
# Estado do registo SIP e dos endpoints
docker exec falai-asterisk asterisk -rx "pjsip show registrations"
docker exec falai-asterisk asterisk -rx "pjsip show endpoints"

# Recarregar config à mão (se o sync não chegar ao motor)
docker exec falai-asterisk asterisk -rx "pjsip reload"

# Chamada de teste pelo ARI, como a API faz
./infra/asterisk/test-call.sh 9XXXXXXXX

# Reiniciar o motor
docker compose -f infra/asterisk/docker-compose.yml restart
```

Config importante: `infra/asterisk/.env` (EXTERNAL_IP) e `.env` da raiz
(`TELEPHONY_ENGINE`, `ASTERISK_ARI_*`, `ASTERISK_AMI_*`,
`ASTERISK_DIAL_FORMAT`, `ASTERISK_CALLER_ID`).

**Regra de trabalho:** reiniciar sempre API/CRM/backoffice afectados depois de
mudar código, sem esperar que se peça.

---

## 8. Ficheiros de referência que ficam em `docs/`

| Ficheiro | Para quê |
|---|---|
| `ESTADO-E-PROXIMOS-PASSOS.md` | **este** — ponto de partida de cada sessão |
| `AVALIACAO-MODELO-SIP-ANGOVOIP.txt` | direcção em vigor, detalhe técnico e decisões datadas |
| `PLATAFORMA.md` | descrição de negócio dos dois produtos e arquitectura |
| `DADOS-CONEXAO-API-PROVIDER.txt` | dados de ligação do provedor |
| `../DEPLOY.md` | pôr a plataforma numa VPS |
| `../infra/asterisk/README.md` | operar o motor SIP |

**Eliminados em 29/07** por estarem fora da direcção actual:
- `PLANO-INDEPENDENCIA-PBX.txt` — plano de o Falaí ser central completa;
  substituído pelo modelo "cliente SIP" (o próprio AVALIACAO dizia que o
  substituía).
- `sip_trunk.md` — spec de paridade com o Yeastar (extensões, grupos, roles,
  rotas, IVR). Esse âmbito passou para a ANGOVOIP. Recuperável no git
  (`git show 7a668e3:docs/sip_trunk.md`).

`../melhorias.md` (módulo Clínica, já implementado e verificado) ficou na raiz —
é histórico de implementação concluída; podes apagar quando quiseres.
