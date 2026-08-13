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
 */
import type { AsteriskAdapter } from "@falai/providers";
import { extensionEndpointId, extensionWebEndpointId } from "@falai/providers";
import type { CallEvent } from "@falai/shared";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import { resolveInboundGlobal } from "./callRouting.service.js";

const RING_TIMEOUT_SECS = 25;

export function registerInboundCallRouter(
  onCallEvent: (handler: (event: CallEvent) => Promise<void>) => void,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): void {
  onCallEvent(async (event) => {
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
  const route = await resolveInboundGlobal(event.did);
  if (!route || route.destType !== "EXTENSION") {
    log.info({ did: event.did, route }, "inbound_call_router.no_route");
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
