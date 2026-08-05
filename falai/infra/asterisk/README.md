# Prova de conceito — motor SIP próprio

Etapa 1 do [plano de independência do PBX](../../docs/PLANO-INDEPENDENCIA-PBX.txt).

**Objectivo:** provar que o Falaí consegue registar o trunk da ANGOVOIP e completar
uma chamada real **sem passar pelo Yeastar**. É o teste que valida (ou invalida) o
projecto todo, e custa dias em vez de meses.

**Isolamento:** isto não toca na API, no CRM, no backoffice nem na base de dados.
Os clientes que estão a testar não são afectados de forma nenhuma.

---

## Arrancar

```bash
cp infra/asterisk/.env.example infra/asterisk/.env
# preencher TRUNK_PASSWORD e EXT_1000_PASSWORD
docker compose -f infra/asterisk/docker-compose.yml up --build
```

A password do trunk **nunca** entra em ficheiros versionados — o `.env` está no
`.gitignore` e o repositório é público.

## Verificar o registo

```bash
docker exec -it falai-asterisk asterisk -rvvv
```

Na consola do Asterisk:

```
pjsip show registrations     ← queremos "Registered"
pjsip show endpoints         ← estado do trunk e da extensão 1000
pjsip show aors
```

Se aparecer `Registered`, **metade do risco do projecto desapareceu**: as
credenciais funcionam e o Falaí fala directamente com a ANGOVOIP.

Se aparecer `Rejected` ou `Auth Failed`, ver a secção de diagnóstico no fim.

## Testar chamadas

### 1. Chamada originada pela plataforma (o teste que interessa)

```bash
./infra/asterisk/test-call.sh 9XXXXXXXX
```

Usa o ARI, exactamente como a API do Falaí, e vai buscar o trunk ao dialplan —
não há nada para configurar à mão. É isto que as campanhas e o agente de IA
fazem, por isso é o teste que prova o produto.

### 2. Chamada a partir de um softphone

Regista um softphone (Zoiper, Linphone) com:

| Campo | Valor |
|---|---|
| Utilizador | o **utilizador SIP** da extensão (ex.: `FAWFyFTRBv`), não o número |
| Password | o segredo da extensão, visível no CRM/backoffice |
| Servidor | o IP da máquina onde corre o Docker |

> O utilizador **não** é `1000`. Os endpoints passaram a chamar-se como o
> utilizador SIP, porque é assim que o PJSIP identifica quem se regista e
> porque o número 1000 repete-se entre clientes. Ver `asteriskNaming.ts`.

Depois marca:

1. **`600`** — teste de eco. Não sai para a rede, não gasta minutos. Ouves a tua
   própria voz com atraso? Então o RTP funciona nos dois sentidos localmente.
2. **Um telemóvel real** (`9XXXXXXXX`) — sai pelo trunk da ANGOVOIP.

Não há chamada entre extensões por número: no modelo actual as chamadas
internas são da ANGOVOIP. Ver `docs/AVALIACAO-MODELO-SIP-ANGOVOIP.txt`.

## Se mexeres na configuração e nada mudar no motor

A API escreve `generated/*.conf` e manda recarregar por AMI. Os recarregamentos
vão **espaçados de 2 segundos de propósito**: o Asterisk trata um de cada vez e
responde `Success` a pedidos que descarta por já ter outro em curso. Em rajada,
anulavam-se e a configuração nova nunca entrava.

Para ver se o sync chegou ao motor:

```bash
docker exec falai-asterisk asterisk -rx "pjsip show endpoints"
docker exec falai-asterisk asterisk -rx "dialplan show globals"   # TRUNK_ENDPOINT
```

## O que observar durante os testes

- **Codec negociado** — queremos ALAW. Confirmar com `pjsip show channelstats`
  ou `core show channels verbose` durante a chamada. Se a ANGOVOIP impuser G.729,
  isso degrada a transcrição da IA (plano §9.5 e §16.3) e é assunto para a reunião.
- **Tempo de estabelecimento** — quanto tempo entre marcar e tocar.
- **Áudio nos dois sentidos** — é o ponto crítico. Ver abaixo.

---

## Limitação conhecida: áudio só num sentido

**É o problema mais comum de todos** (plano §16.2) e é quase garantido num teste
a partir de casa ou do escritório.

O registo e o estabelecimento da chamada partem de dentro para fora e atravessam
NAT sem dificuldade. Já o **áudio de retorno** vem de fora para dentro e o router
tende a bloqueá-lo. Resultado típico: ouves a outra pessoa mas ela não te ouve,
ou o inverso.

Em macOS há ainda uma segunda camada: o Docker Desktop não suporta
`network_mode: host`, por isso o RTP passa pela tradução de portas do Docker —
outra fonte do mesmo problema.

**O que isto significa na prática:**

| Resultado do teste local | Conclusão |
|---|---|
| Trunk regista | ✅ credenciais válidas, ANGOVOIP alcançável |
| Chamada estabelece | ✅ sinalização e encaminhamento correctos |
| Áudio nos dois sentidos | ⚠️ se falhar, provavelmente é o NAT — **não** conclusão sobre o projecto |

Preencher `EXTERNAL_IP` no `.env` com o IP público (`curl ifconfig.me`) ajuda,
mas o teste definitivo do áudio **exige o servidor Linux com IP público directo**
e `network_mode: host`. Não tirar conclusões negativas sobre a viabilidade do
projecto a partir de um teste caseiro de áudio.

---

## Diagnóstico

Capturar o SIP para ver o que passa na realidade:

```bash
docker exec -it falai-asterisk sngrep
```

| Sintoma | Causa provável |
|---|---|
| `Auth Failed` / 401 persistente | password errada, ou utilizador não é o que pensas |
| `Rejected` / 403 | o nosso IP não está na allowlist da ANGOVOIP (plano §9.2) |
| Sem resposta ao REGISTER | firewall a bloquear 5060/udp, ou host/porta errados |
| Chamada cai a meio (~30s) | ACK ou re-INVITE perdidos por NAT |
| Áudio só num sentido | NAT/RTP — ver secção acima |
| `503` ao marcar | limite de canais ou CPS da ANGOVOIP (plano §9.3) |

---

## Dados do trunk de teste

Fornecidos pela ANGOVOIP (Julho 2026). **Servidor de testes**, não produção.

| Campo | Valor |
|---|---|
| Host | `87.238.224.117:5060` UDP |
| Utilizador / Auth ID | `878007792000` |
| Password | no `.env` — nunca aqui |
| DID | `244959100363` (opcional, trunk é de saída) |

> **A confirmar com a ANGOVOIP:** estas credenciais são diferentes das que estão
> em `docs/sip_trunk.md` §7 (utilizador `878029113001`, DID `...354`), mas o host
> é o mesmo. São dois ambientes? Uma substitui a outra? Vale a pena esclarecer
> antes de construir a Fase 2 em cima da conta errada.

---

## O que vem a seguir

Validada esta etapa, segue-se a **Etapa 2**: o Asterisk deixa de ter configuração
própria e passa a ler extensões, trunks e rotas directamente do PostgreSQL do
Falaí (PJSIP Realtime). Estes ficheiros de template desaparecem — a base de dados
passa a ser a única fonte de verdade.
