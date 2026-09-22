/**
 * Encaminhamento de chamadas de entrada do motor Asterisk nativo (secção 6 do
 * plano do webphone). Antes disto, nada tratava o evento que o dialplan
 * entrega a Stasis(falai,inbound,${EXTEN}) — a chamada nunca tocava em lado
 * nenhum. Só suporta InboundRoute.destType === "EXTENSION" para já; GROUP/IVR/
 * AI_AGENT ficam no fallback de "sem rota" (fica registado, não é regressão:
 * nada disto tocava antes).
 *
 * "Ring group": toca em simultâneo no endpoint de hardphone e no de webphone
 * da mesma extensão (ver asteriskNaming.ts); quem atender primeiro entra na
 * bridge com o canal do trunk, o outro é desligado.
 *
 * REGISTO E COBRANÇA
 * O encaminhamento não passava pela tabela Call, por isso as chamadas que
 * entram por um trunk de peering não apareciam em lado nenhum e não eram
 * cobradas. Agora abre-se a linha assim que se sabe o tenant e fecha-se no
 * evento terminal do canal do trunk, cobrando o tempo de conversa ao preço do
 * plano — o mesmo padrão "regista e cobra de uma só vez, sem reservas" do
 * webphoneCdr.service.ts.
 */
import type { AsteriskAdapter } from "@falai/providers";
import { extensionEndpointId, extensionWebEndpointId } from "@falai/providers";
import type { CallEvent } from "@falai/shared";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import { resolveInboundGlobal, resolveInboundForTenant } from "./callRouting.service.js";
import {
  computeCallCost,
  effectiveBillingMode,
  reserveBalance,
  type PriceConfig,
} from "./billing.service.js";

const RING_TIMEOUT_SECS = 25;

export function registerInboundCallRouter(
  onCallEvent: (handler: (event: CallEvent) => Promise<void>) => void,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): void {
  onCallEvent(async (event) => {
    // O canal do trunk morreu: é aqui — e só aqui — que a chamada de entrada se
    // fecha e se cobra. CALL_FAILED chega quando o canal nunca chegou a estar
    // "Up"; para uma chamada de entrada isso não acontece (atendemo-la nós à
    // entrada), mas trata-se na mesma para o registo não ficar pendurado.
    if (event.type === "CALL_ENDED" || event.type === "CALL_FAILED") {
      await closeInboundCall(
        event.providerCallId,
        event.type === "CALL_ENDED" ? event.endedAt : new Date(),
        log
      );
      return;
    }
    if (event.type !== "INBOUND_CALL_STARTED") return;
    try {
      await handleInboundCall(event, asterisk, log);
    } catch (err) {
      log.error({ err, providerCallId: event.providerCallId }, "inbound_call_router.failed");
      await asterisk.noRouteFallback(event.providerCallId).catch(() => {});
    }
  });
}

async function handleInboundCall(
  event: Extract<CallEvent, { type: "INBOUND_CALL_STARTED" }>,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): Promise<void> {
  // Quando a chamada entrou por um trunk exclusivo de um cliente (peering por
  // IP), o tenant vem no evento e a rota procura-se só dentro dele. É mais
  // correcto do que procurar pelo DID em toda a plataforma: num peering a
  // numeração é interna do cliente e repete-se entre clientes — sem isto, a
  // chamada de um cliente podia tocar na extensão de outro.
  const route = event.tenantId
    ? await resolveInboundForTenant(event.tenantId, event.did)
    : await resolveInboundGlobal(event.did);

  if (!route || route.destType !== "EXTENSION") {
    log.info({ did: event.did, tenantId: event.tenantId ?? null, route }, "inbound_call_router.no_route");
    await asterisk.noRouteFallback(event.providerCallId);
    return;
  }

  const ext = await prisma.extension.findFirst({
    where: { tenantId: route.tenantId, number: route.destValue, isActive: true },
    select: { sipAuthUser: true },
  });
  if (!ext) {
    log.warn({ did: event.did, route }, "inbound_call_router.extension_not_found");
    await asterisk.noRouteFallback(event.providerCallId);
    return;
  }

  // O registo nasce aqui, assim que se sabe de quem é a chamada: a tabela Call é
  // a fonte de verdade da facturação (ver routes/v1/usage.ts) e sem linha a
  // chamada é invisível — não aparece na lista nem conta para o consumo. Fica de
  // fora, de propósito, tudo o que caiu no noRouteFallback acima: uma chamada
  // que não tocou em ninguém não se regista nem se cobra.
  await openInboundCall(event, route.tenantId, log);

  const targets = [extensionEndpointId(ext.sipAuthUser), extensionWebEndpointId(ext.sipAuthUser)];
  const bridge = await asterisk.createBridge();
  await asterisk.answerChannel(event.providerCallId);
  await asterisk.addChannelToBridge(bridge.id, event.providerCallId);

  const originated = await Promise.all(
    targets.map((endpointId) =>
      asterisk
        .originateToPjsipEndpoint(endpointId, `ring:${bridge.id}`, event.callerIdNum, RING_TIMEOUT_SECS)
        .then((ch) => ch.id)
        .catch((err) => {
          log.warn({ err, endpointId }, "inbound_call_router.originate_failed");
          return null;
        })
    )
  );
  const channelIds = originated.filter((id): id is string => id !== null);

  if (channelIds.length === 0) {
    log.warn({ did: event.did, targets }, "inbound_call_router.no_target_reachable");
    await asterisk.noRouteFallback(event.providerCallId);
    // A bridge já existe: sem isto ficava órfã no Asterisk a cada chamada de
    // entrada que não encontra ninguém.
    await asterisk.destroyBridge(bridge.id).catch(() => {});
    return;
  }

  asterisk.registerRingGroup(
    channelIds,
    (answeredId) => {
      // Instante em que ALGUÉM atendeu — é a partir daqui que há conversa e,
      // portanto, tempo a cobrar.
      void markInboundAnswered(event.providerCallId, log);
      asterisk.addChannelToBridge(bridge.id, answeredId).catch((err) => log.error({ err }, "inbound_call_router.bridge_join_failed"));
      for (const id of channelIds) {
        if (id !== answeredId) asterisk.hangup(id).catch(() => {});
      }
    },
    () => {
      log.info({ did: event.did }, "inbound_call_router.nobody_answered");
      asterisk.noRouteFallback(event.providerCallId).catch(() => {});
      asterisk.destroyBridge(bridge.id).catch(() => {});
    }
  );
}

/**
 * Abre o registo da chamada de entrada. Idempotente pelo id do canal do trunk:
 * a coluna `yeastarCallId` é única, por isso uma reentrega do StasisStart (ou
 * dois handlers a correr em paralelo) não duplica a linha nem a rebobina para
 * RINGING — é a mesma garantia que o CDR do webphone usa.
 */
async function openInboundCall(
  event: Extract<CallEvent, { type: "INBOUND_CALL_STARTED" }>,
  tenantId: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    await prisma.call.upsert({
      where: { yeastarCallId: event.providerCallId },
      create: {
        tenantId,
        kind: "INBOUND",
        status: "RINGING",
        // O DID é o número que o chamador marcou: do nosso lado é o destino.
        toNumber: event.did,
        ...(event.callerIdNum ? { fromNumber: event.callerIdNum } : {}),
        yeastarCallId: event.providerCallId,
        startedAt: new Date(),
      },
      update: {},
    });
  } catch (err) {
    // Contabilidade nunca derruba a chamada: sem registo o cliente perde a
    // linha na lista, mas continua a falar.
    log.error({ err, providerCallId: event.providerCallId }, "inbound_call_router.call_row_failed");
  }
}

/** Passa o registo a IN_PROGRESS quando uma das pernas do ring group atende. */
async function markInboundAnswered(providerCallId: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await prisma.call.updateMany({
      where: { yeastarCallId: providerCallId, kind: "INBOUND", status: "RINGING" },
      data: { status: "IN_PROGRESS", answeredAt: new Date() },
    });
  } catch (err) {
    log.error({ err, providerCallId }, "inbound_call_router.answer_mark_failed");
  }
}

/**
 * Fecha o registo e cobra, de uma vez só — como no CDR do webphone, não há
 * reserva a acertar porque a chamada só é conhecida depois de acontecer.
 *
 * IDEMPOTÊNCIA: o updateMany só apanha a linha enquanto ela está RINGING ou
 * IN_PROGRESS. Quem fizer a transição apanha `count === 1` e é o único a cobrar;
 * um segundo evento terminal para o mesmo canal encontra a linha já fechada,
 * apanha `count === 0` e sai sem tocar na carteira.
 */
async function closeInboundCall(
  providerCallId: string,
  endedAt: Date,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const call = await prisma.call.findUnique({
      where: { yeastarCallId: providerCallId },
      select: { id: true, tenantId: true, kind: true, answeredAt: true },
    });
    // Os eventos terminais chegam para TODAS as chamadas do motor (directas,
    // agente de IA, ...) — aqui só nos interessam as de entrada.
    if (!call || call.kind !== "INBOUND") return;

    // Não se usa o `durationSecs` do evento: o canal do trunk é atendido por nós
    // no início do encaminhamento, por isso a duração dele inclui o tempo de
    // toque. Cobrar isso era cobrar chamadas que ninguém atendeu. O tempo
    // facturável conta-se do momento em que uma extensão atendeu.
    // Math.ceil e não Math.round: o `answeredAt` só existe se alguém atendeu
    // mesmo, por isso uma chamada de 400 ms é uma chamada atendida. Com round
    // dava 0 segundos, e 0 segundos não se cobra em modo nenhum — nem sequer
    // em PER_CALL, onde a chamada devia custar o preço cheio.
    const billedSecs = call.answeredAt
      ? Math.max(0, Math.ceil((endedAt.getTime() - call.answeredAt.getTime()) / 1000))
      : 0;
    const status = call.answeredAt ? "COMPLETED" : "NO_ANSWER";

    const claimed = await prisma.call.updateMany({
      where: { id: call.id, status: { in: ["RINGING", "IN_PROGRESS"] } },
      data: { status, outcome: status, endedAt, durationSecs: billedSecs, billedSecs },
    });
    if (claimed.count === 0) return; // já fechada (e já cobrada) por outro evento

    if (billedSecs <= 0) return; // ninguém atendeu: não há nada a cobrar
    await chargeInboundCall(call.id, call.tenantId, billedSecs, log);
  } catch (err) {
    log.error({ err, providerCallId }, "inbound_call_router.close_failed");
  }
}

/**
 * Debita a chamada de entrada. Por decisão de negócio usa-se o MESMO preço do
 * plano que nas chamadas de saída: com PER_CALL dá o preço por chamada, com
 * PER_MINUTE/PER_SECOND o tempo de conversa.
 */
async function chargeInboundCall(
  callId: string,
  tenantId: string,
  billedSecs: number,
  log: FastifyBaseLogger
): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      billingModeOverride: true,
      plan: { select: { billingMode: true, pricePerMinuteCents: true, pricePerCallCents: true } },
    },
  });
  if (!tenant) return;

  const price: PriceConfig = {
    billingMode: effectiveBillingMode(tenant.plan.billingMode, tenant.billingModeOverride),
    pricePerMinuteCents: tenant.plan.pricePerMinuteCents,
    pricePerCallCents: tenant.plan.pricePerCallCents,
  };
  const costCents = computeCallCost(billedSecs, price);
  if (costCents <= 0) return;

  // A chamada já aconteceu: se o saldo não chega cobra-se na mesma e o cliente
  // fica negativo — recusar aqui seria dar a chamada de graça.
  const ok = await reserveBalance(tenantId, costCents);
  if (!ok) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { balanceCents: { decrement: costCents } },
    });
    log.warn({ tenantId, callId }, "inbound_call_router.charged_into_negative");
  }

  const balance = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { balanceCents: true },
  });
  await Promise.all([
    prisma.walletTransaction.create({
      data: {
        tenantId,
        type: "CALL_CHARGE",
        amountCents: -costCents,
        balanceAfterCents: balance.balanceCents,
        note: `Chamada de entrada ${callId} — ${billedSecs}s`,
        reference: callId,
      },
    }),
    prisma.call.update({ where: { id: callId }, data: { costCents } }),
  ]);

  log.info({ callId, tenantId, billedSecs, costCents }, "inbound_call_router.charged");
}
