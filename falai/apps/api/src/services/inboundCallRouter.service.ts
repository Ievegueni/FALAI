/**
 * Encaminhamento de chamadas de entrada do motor Asterisk nativo (secção 6 do
 * plano do webphone). Antes disto, nada tratava o evento que o dialplan
 * entrega a Stasis(falai,inbound,${EXTEN}) — a chamada nunca tocava em lado
 * nenhum. Destinos suportados: EXTENSION, GROUP (toca em todos os membros) e
 * IVR (menu de voz — ver secção IVR abaixo). AI_AGENT fica no fallback de
 * "sem rota".
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
import { extensionEndpointId, extensionWebEndpointId, holdMusicClass } from "@falai/providers";
import type { CallEvent } from "@falai/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { resolveInboundGlobal, resolveInboundForTenant } from "./callRouting.service.js";
import {
  startCallRecording,
  stopCallRecording,
  saveFinishedRecording,
} from "./callRecording.service.js";
import { notifyMissedCall } from "./missedCallSms.service.js";
import {
  computeCallCost,
  effectiveBillingMode,
  reserveBalance,
  type PriceConfig,
} from "./billing.service.js";

const RING_TIMEOUT_SECS = 25;

type InboundEvent = Extract<CallEvent, { type: "INBOUND_CALL_STARTED" }>;
interface Dest { destType: string; destValue: string }

/**
 * Chamadas de entrada que chegaram mesmo a tocar numa extensão.
 *
 * Serve o SMS de chamada não atendida: quem desliga ainda dentro do menu do IVR
 * não "ficou sem resposta" — ninguém era suposto atendê-lo ainda —, e mandar-lhe
 * uma mensagem a pedir desculpa seria errado (e pago).
 */
const rangExtension = new Set<string>();

export function registerInboundCallRouter(
  onCallEvent: (handler: (event: CallEvent) => Promise<void>) => void,
  asterisk: AsteriskAdapter,
  fastify: FastifyInstance,
  log: FastifyBaseLogger
): void {
  onCallEvent(async (event) => {
    // O canal do trunk morreu: é aqui — e só aqui — que a chamada de entrada se
    // fecha e se cobra. CALL_FAILED chega quando o canal nunca chegou a estar
    // "Up"; para uma chamada de entrada isso não acontece (atendemo-la nós à
    // entrada), mas trata-se na mesma para o registo não ficar pendurado.
    if (event.type === "CALL_ENDED" || event.type === "CALL_FAILED") {
      endIvr(event.providerCallId);
      await closeInboundCall(
        event.providerCallId,
        event.type === "CALL_ENDED" ? event.endedAt : new Date(),
        asterisk,
        fastify,
        log
      );
      return;
    }
    // A gravação fecha depois da chamada e sem canal associado — liga-se à
    // linha da tabela Call pelo nome do ficheiro.
    if (event.type === "RECORDING_FINISHED") {
      await saveFinishedRecording(event.recordingName, event.format, log);
      return;
    }
    if (event.type === "RECORDING_FAILED") {
      log.error(
        { recordingName: event.recordingName, reason: event.reason },
        "inbound_call_router.recording_failed"
      );
      return;
    }
    if (event.type === "DTMF") {
      const s = ivrSessions.get(event.providerCallId);
      if (s) await onIvrDigit(s, event.digit, asterisk, log);
      return;
    }
    if (event.type === "PROMPT_FINISHED") {
      const s = ivrSessions.get(event.providerCallId);
      // Só o fim da saudação actual arma a espera: um playback cortado a meio
      // (repetição) também gera PROMPT_FINISHED, com o id antigo. O fim das
      // boas-vindas não arma nada: passa à saudação das opções.
      if (s && event.playbackId === s.playbackId) {
        if (s.welcome) await playGreeting(s, asterisk, log);
        else armIvrTimeout(s, asterisk, log);
      }
      return;
    }
    if (event.type !== "INBOUND_CALL_STARTED") return;
    try {
      await handleInboundCall(event, asterisk, log);
    } catch (err) {
      log.error({ err, providerCallId: event.providerCallId }, "inbound_call_router.failed");
      endIvr(event.providerCallId);
      await asterisk.noRouteFallback(event.providerCallId).catch(() => {});
    }
  });
}

async function handleInboundCall(
  event: InboundEvent,
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

  if (!route) {
    log.info({ did: event.did, tenantId: event.tenantId ?? null }, "inbound_call_router.no_route");
    await asterisk.noRouteFallback(event.providerCallId);
    return;
  }
  await routeTo(event, route.tenantId, route, asterisk, log);
}

/** Encaminha para um destino — usado pela rota de entrada e pelas opções do IVR. */
async function routeTo(
  event: InboundEvent,
  tenantId: string,
  dest: Dest,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): Promise<void> {
  if (dest.destType === "IVR") {
    await startIvr(event, tenantId, dest.destValue, asterisk, log);
    return;
  }

  const sipUsers = await resolveSipUsers(tenantId, dest);
  if (sipUsers.length === 0) {
    log.warn({ did: event.did, dest }, "inbound_call_router.no_target");
    await asterisk.noRouteFallback(event.providerCallId);
    return;
  }

  // O registo nasce aqui, assim que se sabe de quem é a chamada: a tabela Call é
  // a fonte de verdade da facturação (ver routes/v1/usage.ts) e sem linha a
  // chamada é invisível — não aparece na lista nem conta para o consumo. Fica de
  // fora, de propósito, tudo o que caiu no noRouteFallback acima: uma chamada
  // que não tocou em ninguém não se regista nem se cobra.
  const callId = await openInboundCall(event, tenantId, log);
  await ringTargets(
    event,
    sipUsers.flatMap((u) => [extensionEndpointId(u), extensionWebEndpointId(u)]),
    callId,
    tenantId,
    asterisk,
    log
  );
}

/** Utilizadores SIP a tocar: a extensão, ou os membros activos do grupo. */
async function resolveSipUsers(tenantId: string, dest: Dest): Promise<string[]> {
  if (dest.destType === "EXTENSION") {
    const ext = await prisma.extension.findFirst({
      where: { tenantId, number: dest.destValue, isActive: true },
      select: { sipAuthUser: true },
    });
    return ext ? [ext.sipAuthUser] : [];
  }
  if (dest.destType === "GROUP") {
    const members = await prisma.extensionGroupMember.findMany({
      where: { groupId: dest.destValue, group: { tenantId }, extension: { isActive: true } },
      select: { extension: { select: { sipAuthUser: true } } },
    });
    return members.map((m) => m.extension.sipAuthUser);
  }
  return [];
}

async function ringTargets(
  event: InboundEvent,
  targets: string[],
  callId: string | null,
  tenantId: string,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): Promise<void> {
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

  // A partir daqui a chamada tocou mesmo em alguém — é o que distingue "não
  // atenderam" de "desligou no menu".
  if (channelIds.length > 0) rangExtension.add(event.providerCallId);

  // Enquanto toca, quem liga ouve a música de espera do cliente (na bridge,
  // onde por agora só está ele) ou, sem música, o sinal de chamada. Sem nada
  // ouvia silêncio e desligava.
  let ringbackId: string | null = null;
  let moh = false;
  if (channelIds.length > 0) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { holdAudio: true } });
    if (t?.holdAudio) {
      try {
        await asterisk.startBridgeMoh(bridge.id, holdMusicClass(tenantId));
        moh = true;
      } catch (err) {
        log.warn({ err, providerCallId: event.providerCallId }, "inbound_call_router.hold_music_failed");
      }
    }
    if (!moh) {
      try {
        ringbackId = (await asterisk.startRingback(event.providerCallId)).id;
      } catch (err) {
        log.warn({ err, providerCallId: event.providerCallId }, "inbound_call_router.ringback_failed");
      }
    }
  }
  // A música pára ANTES de o agente entrar na bridge, senão ouvia-a também.
  const stopRingback = () =>
    moh
      ? asterisk.stopBridgeMoh(bridge.id).catch(() => {})
      : ringbackId
        ? asterisk.stopPlayback(ringbackId).catch(() => {})
        : Promise.resolve();

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
      stopRingback()
        .then(() => asterisk.addChannelToBridge(bridge.id, answeredId))
        .then(() => {
          // Só depois de os dois lados estarem na bridge é que há conversa para
          // gravar — gravar antes disso dava um ficheiro com o sinal de chamada.
          if (callId) {
            void startCallRecording({ callId, tenantId, bridgeId: bridge.id, asterisk, log });
          }
        })
        .catch((err) => log.error({ err }, "inbound_call_router.bridge_join_failed"));
      for (const id of channelIds) {
        if (id !== answeredId) asterisk.hangup(id).catch(() => {});
      }
    },
    () => {
      log.info({ did: event.did }, "inbound_call_router.nobody_answered");
      void stopRingback().then(() => asterisk.noRouteFallback(event.providerCallId).catch(() => {}));
      asterisk.destroyBridge(bridge.id).catch(() => {});
    }
  );
}

// ─── IVR ────────────────────────────────────────────────────────────────────
// Toca as boas-vindas, se o menu as tiver (custom/ivr_<id>_welcome, só uma vez),
// depois a saudação do menu (custom/ivr_<id>, gerada por TTS ao gravar) e espera
// por um dígito. O chamador pode premir a meio da saudação. Dígito inválido ou
// silêncio repetem a saudação até maxRetries; depois cai no aviso de "sem
// serviço". O tempo no menu não se cobra: a cobrança conta de quando uma
// extensão atende (ver closeInboundCall).
// ponytail: sessões em memória — um reinício da API larga os menus a meio;
// passar para Redis se houver mais de uma instância da API.

export interface IvrOption extends Dest { digit: string }

interface IvrSession {
  event: InboundEvent;
  tenantId: string;
  menu: { id: string; options: IvrOption[]; timeoutSecs: number; maxRetries: number };
  retries: number;
  playbackId?: string;
  /** A tocar as boas-vindas: o fim do playback passa à saudação, não arma a espera. */
  welcome?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const ivrSessions = new Map<string, IvrSession>();

async function startIvr(
  event: InboundEvent,
  tenantId: string,
  menuId: string,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): Promise<void> {
  const menu = await prisma.ivrMenu.findFirst({
    where: { id: menuId, tenantId },
    select: { id: true, options: true, timeoutSecs: true, maxRetries: true, welcomeAudio: true },
  });
  if (!menu) {
    log.warn({ did: event.did, menuId }, "inbound_call_router.ivr_not_found");
    await asterisk.noRouteFallback(event.providerCallId);
    return;
  }
  await openInboundCall(event, tenantId, log);
  await asterisk.answerChannel(event.providerCallId);

  endIvr(event.providerCallId); // submenu: substitui a sessão do menu anterior
  const { welcomeAudio, ...menuData } = menu;
  const s: IvrSession = {
    event,
    tenantId,
    menu: { ...menuData, options: Array.isArray(menu.options) ? (menu.options as unknown as IvrOption[]) : [] },
    retries: 0,
  };
  ivrSessions.set(event.providerCallId, s);
  if (welcomeAudio) await playWelcome(s, asterisk, log);
  else await playGreeting(s, asterisk, log);
}

// Boas-vindas: tocam uma vez; um dígito a meio já conta (onIvrDigit). Se
// falharem, segue-se para a saudação em vez de largar a chamada.
async function playWelcome(s: IvrSession, asterisk: AsteriskAdapter, log: FastifyBaseLogger): Promise<void> {
  const id = s.event.providerCallId;
  try {
    s.welcome = true;
    s.playbackId = (await asterisk.playMediaOnChannel(id, `ivr_${s.menu.id}_welcome`)).id;
  } catch (err) {
    log.warn({ err, providerCallId: id }, "inbound_call_router.ivr_welcome_failed");
    await playGreeting(s, asterisk, log);
  }
}

async function playGreeting(s: IvrSession, asterisk: AsteriskAdapter, log: FastifyBaseLogger): Promise<void> {
  const id = s.event.providerCallId;
  s.welcome = false;
  try {
    s.playbackId = (await asterisk.playMediaOnChannel(id, `ivr_${s.menu.id}`)).id;
  } catch (err) {
    log.error({ err, providerCallId: id }, "inbound_call_router.ivr_play_failed");
    endIvr(id);
    await asterisk.noRouteFallback(id).catch(() => {});
  }
}

function armIvrTimeout(s: IvrSession, asterisk: AsteriskAdapter, log: FastifyBaseLogger): void {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    if (ivrSessions.get(s.event.providerCallId) === s) void retryIvr(s, asterisk, log);
  }, s.menu.timeoutSecs * 1000);
}

async function retryIvr(s: IvrSession, asterisk: AsteriskAdapter, log: FastifyBaseLogger): Promise<void> {
  const id = s.event.providerCallId;
  if (++s.retries > s.menu.maxRetries) {
    log.info({ providerCallId: id, menuId: s.menu.id }, "inbound_call_router.ivr_gave_up");
    endIvr(id);
    await asterisk.noRouteFallback(id).catch(() => {});
    return;
  }
  if (s.playbackId) await asterisk.stopPlayback(s.playbackId).catch(() => {});
  await playGreeting(s, asterisk, log);
}

async function onIvrDigit(s: IvrSession, digit: string, asterisk: AsteriskAdapter, log: FastifyBaseLogger): Promise<void> {
  clearTimeout(s.timer);
  const opt = s.menu.options.find((o) => o.digit === digit);
  log.info({ providerCallId: s.event.providerCallId, digit, dest: opt ?? null }, "inbound_call_router.ivr_digit");
  if (!opt) {
    await retryIvr(s, asterisk, log);
    return;
  }
  endIvr(s.event.providerCallId);
  if (s.playbackId) await asterisk.stopPlayback(s.playbackId).catch(() => {});
  await routeTo(s.event, s.tenantId, opt, asterisk, log);
}

function endIvr(providerCallId: string): void {
  const s = ivrSessions.get(providerCallId);
  if (!s) return;
  clearTimeout(s.timer);
  ivrSessions.delete(providerCallId);
}

/**
 * Abre o registo da chamada de entrada. Idempotente pelo id do canal do trunk:
 * a coluna `yeastarCallId` é única, por isso uma reentrega do StasisStart (ou
 * dois handlers a correr em paralelo) não duplica a linha nem a rebobina para
 * RINGING — é a mesma garantia que o CDR do webphone usa.
 */
async function openInboundCall(
  event: InboundEvent,
  tenantId: string,
  log: FastifyBaseLogger
): Promise<string | null> {
  try {
    const call = await prisma.call.upsert({
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
      select: { id: true },
    });
    return call.id;
  } catch (err) {
    // Contabilidade nunca derruba a chamada: sem registo o cliente perde a
    // linha na lista, mas continua a falar.
    log.error({ err, providerCallId: event.providerCallId }, "inbound_call_router.call_row_failed");
    return null;
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
  asterisk: AsteriskAdapter,
  fastify: FastifyInstance,
  log: FastifyBaseLogger
): Promise<void> {
  // Lê-se e larga-se sempre, mesmo quando não há nada a fazer com isto: deixar
  // a entrada para trás era ir enchendo o Set a cada chamada.
  const rang = rangExtension.delete(providerCallId);
  try {
    const call = await prisma.call.findUnique({
      where: { yeastarCallId: providerCallId },
      select: { id: true, tenantId: true, kind: true, answeredAt: true, fromNumber: true },
    });
    // Os eventos terminais chegam para TODAS as chamadas do motor (directas,
    // agente de IA, ...) — aqui só nos interessam as de entrada.
    if (!call || call.kind !== "INBOUND") return;

    // Acabou a conversa, acabou a gravação. É este fecho que dispara o
    // RecordingFinished, e portanto o registo do ficheiro na chamada.
    await stopCallRecording(call.id, asterisk, log);

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

    if (billedSecs <= 0) {
      // Ninguém atendeu: não há nada a cobrar, mas há a quem responder. Só se
      // avisa quem chegou a fazer tocar uma extensão — ver rangExtension.
      if (status === "NO_ANSWER" && rang) {
        await notifyMissedCall({
          fastify,
          tenantId: call.tenantId,
          toNumber: call.fromNumber,
          callId: call.id,
          log,
        });
      }
      return;
    }
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
