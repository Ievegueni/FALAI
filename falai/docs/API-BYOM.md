# Falaí — Integração por API com o teu próprio modelo (BYOM)

> Documento de integração. Entrega-se ao cliente tal como está.
> Última actualização: 21/08/2026

Neste modelo tu ficas com o CRM e com o modelo de linguagem. O Falaí fica com a
telefonia, a transcrição, a síntese de voz, a orquestração da conversa e o
controlo da plataforma.

| Falaí | Tu |
|---|---|
| Chamadas (SIP/RTP), STT, TTS, gestão de turnos | O modelo e o treino dele |
| Guardrails, moderação, auditoria, facturação da voz | A tua interface e os teus utilizadores |

Não há interface nossa para usares. Tudo o que se segue é `https://api.falai.ao`.

---

## 1. Como te ligas

**Chave de API.** Nós criamos a chave e entregamos-ta uma única vez — não é
recuperável depois. Envia-a num destes dois cabeçalhos:

```
Authorization: Bearer fal_live_...
```
```
X-API-Key: fal_live_...
```

**Origem.** A chave está fixada aos IPs que nos indicares. Um pedido de outro
endereço recebe `403`, mesmo com a chave correcta. Diz-nos os IPs de saída dos
teus servidores antes de começares, e avisa quando mudarem.

**Âmbitos.** Cada chave só faz o que os âmbitos dela permitem:
`models:read`, `models:write`, `agents:read`, `agents:write`, `calls:read`,
`calls:write`, `contacts:read`, `contacts:write`, `campaigns:read`,
`campaigns:write`, `wallet:read`, `otp:call`, `sms:send`.

**Limites.** 300 pedidos por minuto por chave. Acima disso, `429`.

---

## 1b. Como entra e sai a voz

Há duas formas, e podes usar as duas.

**Pela nossa operadora.** Nada a fazer do teu lado: as chamadas que crias com
`POST /v1/calls` saem pelo trunk que te atribuímos.

**Peering SIP directo (IP-to-IP).** Se já tens central telefónica, ligamo-la ao
nosso nó por endereço, sem registo e sem senha. Dizes-nos o IP público da tua
central e nós damos-te o nosso; a partir daí as duas pontas reconhecem-se pelo
endereço.

O que precisamos de ti:

| | |
|---|---|
| IP público da tua central | um endereço fixo, não um nome de domínio |
| Porta e transporte | 5060/UDP salvo indicação em contrário |
| Codecs | recomendamos `alaw` primeiro — o G.729 poupa banda mas degrada a transcrição |

**Porque exigimos um IP e não um nome:** neste tipo de ligação o endereço é a
única autenticação que existe. Um nome resolve-se, e quem controlasse essa
resolução passaria a poder entrar. Não é negociável.

Do teu lado, abre `5060/udp` e a gama de RTP para o nosso endereço.

**Chamadas de entrada.** Como o trunk é exclusivamente teu, sabemos que a
chamada é tua pelo caminho por onde entrou — não dependemos de o número ser
único entre clientes. Encaminhamos assim:

1. se tiveres uma rota de entrada definida para o número marcado, vale essa;
2. senão, se o número corresponder a uma extensão tua, toca nessa extensão.

Na prática, marcas a extensão e ela toca, sem teres de declarar uma rota por
cada número interno.

---

## 2. O contrato do teu modelo

A cada turno de uma chamada fazemos um `POST` ao teu endpoint e esperamos a
resposta dentro do teu `timeoutMs`. Três formatos possíveis.

### `FALAI_TURN` — o nativo, o mais simples

Enviamos:

```json
{
  "callId": "call_abc123",
  "agentId": "agt_xyz789",
  "locale": "pt-PT",
  "systemPrompt": "És um assistente da empresa X...",
  "history": [
    { "role": "agent", "text": "Bom dia, em que posso ajudar?" },
    { "role": "human", "text": "Queria saber o estado da minha encomenda." }
  ],
  "userText": "É a encomenda 4471.",
  "variables": { "ref": "ord_99" }
}
```

Respondes:

```json
{
  "reply": "A encomenda 4471 sai amanhã de manhã.",
  "action": { "type": "continue" }
}
```

`action.type` aceita quatro valores:

| Valor | O que faz |
|---|---|
| `continue` | continua a conversa (o normal) |
| `end_call` | diz o `reply` e desliga |
| `escalate` | transfere para um humano — exige `"to"` com um número teu |
| `capture` | guarda dados: `"data": { … }` |

### `OPENAI_CHAT` e `ANTHROPIC_MESSAGES`

Se serves o teu modelo por vLLM, Ollama, TGI ou qualquer coisa compatível, não
precisas de escrever adaptador nenhum: escolhe um destes protocolos e nós
falamos o formato deles. Nesse caso o teu modelo devolve só texto, e nós
assumimos `action: {"type": "continue"}`. Se quiseres controlar a acção, devolve
o JSON `{reply, action}` como texto — nós reconhecemo-lo, mesmo dentro de uma
cerca ` ```json `.

### Autenticação e assinatura

Escolhes como te autenticamos: `BEARER` (`Authorization: Bearer <segredo>`),
`HEADER` (um cabeçalho à tua escolha) ou `NONE`.

Se configurares um `signingSecret`, cada pedido nosso leva:

```
X-Falai-Timestamp: 1755777600000
X-Falai-Signature: sha256=<hmac>
```

O HMAC-SHA256 é calculado sobre `` `${timestamp}.${corpo}` `` com esse segredo.
Verifica-o para teres a certeza de que o pedido vem mesmo de nós.

### O que o teu endpoint tem de respeitar

- **`https://` público.** Recusamos endereços internos, `localhost`, IPs
  privados e nomes que resolvam para endereços internos. Portas: 443, 80, 8080
  ou 8443.
- **Sem redirecções.** Aponta o URL directamente ao destino final; um `3xx` é
  tratado como erro.
- **Resposta até 1 MB.**
- **Latência é tudo.** O teu tempo soma-se à transcrição e à síntese. Acima de
  ~2 s o silêncio percebido por quem está ao telefone passa dos 3 segundos.
  Mede com `POST /v1/models/:id/test`.

Se o teu endpoint falhar — tempo esgotado, erro HTTP, resposta fora do contrato
— a chamada **não** cai: falamos uma frase de recurso e seguimos. Três falhas
seguidas suspendem os pedidos ao teu endpoint durante 30 segundos.

---

## 3. Do zero à primeira chamada

### Passo 1 — registar o modelo

```bash
curl -X POST https://api.falai.ao/v1/models \
  -H "X-API-Key: fal_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Modelo de apoio ao cliente",
    "endpointUrl": "https://modelo.a-tua-empresa.com/turn",
    "protocol": "FALAI_TURN",
    "authType": "BEARER",
    "authSecret": "o-teu-token",
    "signingSecret": "segredo-para-verificares-que-somos-nos",
    "timeoutMs": 3000,
    "maxReplyChars": 600
  }'
```

Nasce em `DRAFT`. Nesse estado podes testá-lo e simular à vontade — o que não
faz é atender chamadas.

### Passo 2 — testar

```bash
curl -X POST https://api.falai.ao/v1/models/mdl_abc/test \
  -H "X-API-Key: fal_live_..."
```

```json
{ "ok": true, "latencyMs": 840, "details": "ligado — 840ms totais..." }
```

Repete à vontade: o teste não conta para as falhas que suspendem o endpoint.

### Passo 3 — criar o agente e apontá-lo ao modelo

```bash
curl -X POST https://api.falai.ao/v1/agents \
  -H "X-API-Key: fal_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Apoio ao cliente",
    "systemPrompt": "És um assistente de apoio ao cliente da empresa X. Sê breve.",
    "ttsVoiceId": "pt-AO-female-1",
    "modelId": "mdl_abc",
    "escalationNumber": "+244923000000",
    "maxCallSeconds": 300
  }'
```

Sem `modelId`, o agente usa o motor da plataforma.

### Passo 4 — simular

Conversa em texto, sem telefonia e sem custo de voz. Funciona com o agente em
`DRAFT`, que é precisamente o objectivo.

```bash
curl -X POST https://api.falai.ao/v1/agents/agt_xyz/simulate \
  -H "X-API-Key: fal_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "userText": "Bom dia, queria saber o estado da encomenda 4471." }'
```

```json
{
  "engine": "tenant_model",
  "reply": "Bom dia. A encomenda 4471 sai amanhã de manhã.",
  "action": { "type": "continue" },
  "llmMs": 780,
  "guardrailFlags": []
}
```

Repara em dois campos:

- **`engine`** — `tenant_model` significa que a resposta veio do teu modelo;
  `platform` significa que veio do nosso.
- **`guardrailFlags`** — vazio é o que queres. Se trouxer alguma coisa, a tua
  resposta foi corrigida (ver secção 4).

### Passo 5 — submeter a aprovação

```bash
curl -X POST https://api.falai.ao/v1/models/mdl_abc/submit -H "X-API-Key: fal_live_..."
curl -X POST https://api.falai.ao/v1/agents/agt_xyz/submit -H "X-API-Key: fal_live_..."
```

Passam a `PENDING_REVIEW`. Nós revemos e aprovamos. **Só a partir daí é que
qualquer um dos dois atende uma chamada real.**

Se alterares o prompt do agente ou trocares o modelo depois de aprovado, ele
volta a `DRAFT` — o que aprovámos foi aquela configuração. Submete outra vez.

### Passo 6 — telefonar

```bash
curl -X POST https://api.falai.ao/v1/calls \
  -H "X-API-Key: fal_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "agt_xyz", "toNumber": "+244923000000" }'
```

O resultado chega ao teu webhook (`call.completed`, `call.failed`,
`call.no_answer`, `call.escalated`), assinado com o teu segredo de webhook.

---

## 4. As regras da plataforma

Estas correm do nosso lado, sobre a resposta do teu modelo, imediatamente antes
de ela virar voz. Aplicam-se a todos os modelos, incluindo o nosso, e nada no
teu prompt as desliga — não passam por lá.

| Regra | O que acontece |
|---|---|
| Resposta vazia | falamos uma frase de recurso |
| Resposta acima do teu `maxReplyChars` | é truncada sem partir palavras |
| Frase da lista de proibições da plataforma | a resposta é substituída |
| `action.type` desconhecido | tratado como `continue` |
| `escalate` para um número que não é teu | recusado, a chamada continua |

Cada correcção fica registada e conta. **Ao fim de 20, o modelo é bloqueado
automaticamente** e os agentes que o usam passam a responder pelo nosso motor
até nós o reactivarmos. Vê o contador em `GET /v1/status` e o número de turnos
afectados em `GET /v1/usage` — não esperes pelo bloqueio para reparar.

Guardamos as transcrições e as gravações das chamadas, e registamos quem alterou
o quê e quando.

---

## 5. Referência

### Modelos

| Método | Rota | Âmbito |
|---|---|---|
| `GET` | `/v1/models` | `models:read` |
| `GET` | `/v1/models/:id` | `models:read` |
| `POST` | `/v1/models` | `models:write` |
| `PATCH` | `/v1/models/:id` | `models:write` |
| `POST` | `/v1/models/:id/test` | `models:write` |
| `POST` | `/v1/models/:id/submit` | `models:write` |
| `DELETE` | `/v1/models/:id` | `models:write` |

Campos: `name`, `endpointUrl`, `protocol`, `modelName` (exigido fora de
`FALAI_TURN`), `authType`, `authSecret`, `authHeader` (com `authType=HEADER`),
`signingSecret`, `timeoutMs` (500–10000), `maxReplyChars` (50–1500).

Os segredos entram mas nunca saem: a API devolve `authSecretSet` e
`signingSecretSet`, nunca os valores.

### Agentes

| Método | Rota | Âmbito |
|---|---|---|
| `GET` | `/v1/agents` · `/v1/agents/:id` | `agents:read` |
| `POST` | `/v1/agents` | `agents:write` |
| `PATCH` | `/v1/agents/:id` | `agents:write` |
| `POST` | `/v1/agents/:id/simulate` | `agents:write` |
| `POST` | `/v1/agents/:id/submit` | `agents:write` |

### Operação

| Método | Rota | Âmbito |
|---|---|---|
| `GET` | `/v1/usage?days=30` | `wallet:read` |
| `GET` | `/v1/status` | `models:read` |

`/v1/status` diz-te se podes telefonar (`account.canPlaceCalls`), o estado de
cada modelo, a latência do último teste e o contador de violações.

### O resto

`/v1/calls`, `/v1/contacts`, `/v1/campaigns`, `/v1/sms`, `/v1/otp` e
`/v1/wallet` funcionam como na documentação geral da API.

### Estados

`DRAFT` → `PENDING_REVIEW` → `ACTIVE`, e `BLOCKED` a qualquer momento.

- **`DRAFT`** — teu. Editas, testas e simulas. Não atende chamadas.
- **`PENDING_REVIEW`** — connosco. Não editar; uma alteração cancela a revisão.
- **`ACTIVE`** — em produção.
- **`BLOCKED`** — parado por nós. Não se levanta por edição tua; fala connosco.

### Erros

| Código | Significado |
|---|---|
| `400` | pedido inválido — o corpo traz `details` com o campo em causa |
| `401` | chave em falta, inválida ou revogada |
| `403` | IP de origem não autorizado, ou âmbito em falta |
| `404` | não existe, ou não é desta conta |
| `409` | conflito de estado (ex.: submeter algo já em revisão) |
| `429` | acima de 300 pedidos por minuto |
| `502` | o teu endpoint não respondeu (só no simulador) |

---

## 6. Antes de entrares em produção

- [ ] IPs de saída comunicados e confirmados na chave
- [ ] Se usares peering: IP da tua central comunicado, portas abertas dos dois
      lados, e uma chamada de entrada testada até tocar na extensão certa
- [ ] `signingSecret` configurado e a assinatura verificada do teu lado
- [ ] Latência medida com `/v1/models/:id/test` — de preferência abaixo de 1 s
- [ ] Comportamento em falha testado (desliga o teu endpoint e faz uma chamada:
      deves ouvir a frase de recurso, não silêncio)
- [ ] Webhook a receber e a responder `2xx`
- [ ] `/v1/status` integrado no teu painel, com atenção a `violations`
- [ ] Modelo e agentes aprovados por nós
