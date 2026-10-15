# Falaí — Ligar ao Freshdesk

> Para entregar ao cliente que usa Freshdesk. Com a ligação activa, os tickets
> do Falaí passam a ser um espelho dos do Freshdesk (o Freshdesk continua a
> ser o sistema principal).

## O que o cliente nos dá (ou configura ele no CRM)

1. **Domínio** da conta — ex.: `empresa.freshdesk.com`.
2. **API key** de um **utilizador técnico dedicado** (ex.: "Falaí Integração"),
   com acesso a todos os grupos: Freshdesk → perfil → *Your API Key*.
   Não usar a key de uma pessoa — deixa de funcionar quando ela sai e as
   alterações aparecem em nome dela. A key fica guardada encriptada.
3. Confirmar que os **emails dos agentes** são os mesmos no Freshdesk e no
   Falaí, e os **nomes dos grupos** iguais aos grupos do Falaí — é assim que se
   correspondem responsável e equipa.
4. Decidir: ticket no fim de **cada** chamada atendida, só **quando o agente
   cria**, ou **nunca**; e se o ticket leva a **ligação para a gravação**.

## Onde se configura

CRM → **Tickets → Integração Freshdesk** (só administradores). Ao activar, a
ligação é testada; se a key ou o domínio estiverem errados, não activa.
Na primeira ligação importam-se os tickets dos últimos 30 dias.

## A regra de automação no Freshdesk (avisos em tempo real)

A página da integração mostra o URL e o corpo a usar:

1. Freshdesk → Admin → **Automations → Ticket updates → New rule**.
2. Quando: *Ticket is updated* (ou estado / prioridade / responsável mudam).
3. Acção: **Trigger webhook** — `POST`, conteúdo JSON, URL e corpo da página.
4. Guardar e activar.

Sem a regra funciona na mesma: o Falaí vai buscar as alterações a cada 5 minutos.

## Como funciona

| Sentido | O quê | Quando |
|---|---|---|
| Falaí → Freshdesk | criar ticket, estado, prioridade, responsável, grupo, assunto, nível e tipificação (etiquetas), notas internas (como notas privadas) | logo a seguir, por uma fila com novas tentativas — o agente nunca fica à espera |
| Freshdesk → Falaí | estado, prioridade, responsável, grupo, assunto; tickets novos | webhook (segundos) e sincronização a cada 5 min |

- Alterações feitas no Falaí que ainda não seguiram não são pisadas pelo que vem
  do Freshdesk; seguem primeiro.
- Estados: Aberto ↔ Open, Pendente ↔ Pending, Resolvido ↔ Resolved, Fechado ↔
  Closed; "Em espera" vai como Pending; os estados próprios do cliente contam
  como abertos.
- Erros (Freshdesk em baixo, key revogada) aparecem na página da integração.

## Por fazer

- **Freshchat** (ver as conversas do cliente no perfil e no screen pop): fica
  para quando houver uma conta para validar a API real.
- Campos personalizados dos tickets do cliente: hoje só os campos padrão.
