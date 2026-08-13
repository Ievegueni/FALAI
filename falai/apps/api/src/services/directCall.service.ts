/**
 * Chamadas directas (click-to-call / DirectCallPage) no motor Asterisk nativo.
 *
 * PORQUÊ ESTE FICHEIRO EXISTE
 * A rota POST /tenant/calls/direct pedia a chamada a `getTenantTelephony()`,
 * que devolve SEMPRE um YeastarAdapter — o PBX global da plataforma ou o do
 * tenant. Com TELEPHONY_ENGINE=asterisk isso significa que a chamada nunca
 * chegava ao nosso Asterisk nem ao trunk do operador: era originada no PBX
 * Yeastar remoto (angovoipdemo...), numa extensão que não é a do cliente, e o
 * telemóvel nunca tocava. A API devolvia 202 na mesma, com o call_id do outro
 * PBX, e o CRM mostrava a chamada como "em curso".
 *
 * COMO FUNCIONA AGORA (click-to-call clássico, em duas pernas)
 *   1. cria-se uma bridge vazia;
 *   2. toca-se a extensão de quem marcou — hardphone e webphone em simultâneo,
 *      como no router de entrada (ver inboundCallRouter.service.ts);
 *   3. quem atender primeiro entra na bridge, a outra perna é desligada;
 *   4. só então se marca o número de destino pelo trunk; quando o destino
 *      atende, entra na mesma bridge.
 * A ordem importa: marcar primeiro o destino faria o cliente ouvir silêncio
 * enquanto o operador ainda não tinha atendido.
 */
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import type { AsteriskAdapter } from "@falai/providers";
import type { CallEvent } from "@falai/shared";
import { extensionEndpointId, extensionWebEndpointId } from "@falai/providers";

const RING_TIMEOUT_SECS = 30;
/**
 * Tempo máximo que uma sessão fica em memória. Uma chamada directa é humana:
 * não dura horas. Sem este tecto, uma sessão cujo fim nunca é sinalizado (um
 * callback que não dispara, um evento ARI perdido) ficava viva para sempre — o
 * polling do CRM nunca parava e a bridge nunca era largada.
 */
const SESSION_MAX_MS = 4 * 60 * 60 * 1000;
/** De quanto em quanto tempo se varrem as sessões expiradas. */
const SWEEP_MS = 5 * 60 * 1000;

interface Session {
  bridgeId: string;
  /** Todos os canais que pertencem a esta chamada, para desligar tudo de uma vez. */
  channels: Set<string>;
  tenantId: string;
  /** Quando a sessão nasceu — usado pela varredura de expiração. */
  startedAt: number;
  /**
   * Todos os canais que alguma vez pertenceram à chamada, incluindo as pernas
   * que perderam o ring group. `channels` perde-as (já estão desligadas), mas o
   * registo no CRM foi criado com o id da PRIMEIRA perna — que pode ter sido
   * uma delas. Sem esta lista, esse registo nunca era encontrado para fechar.
   */
  allChannels: Set<string>;
  /** Segundos de conversa, quando o Asterisk os reporta no fim da chamada. */
  durationSecs?: number;
}

/** Sessões vivas, indexadas pelo id devolvido ao CRM (o canal da extensão). */
const sessions = new Map<string, Session>();

export class DirectCallError extends Error {}

/**
 * Origina uma chamada directa no Asterisk. Devolve o id do canal da extensão,
 * que é o que o CRM usa depois em /direct/hangup e /direct/status.
 */
export async function startAsteriskDirectCall(params: {
  asterisk: AsteriskAdapter;
  tenantId: string;
  fromExtension: string;
  to: string;
  ref: string;
  log: FastifyBaseLogger;
}): Promise<{ providerCallId: string }> {
  const { asterisk, tenantId, fromExtension, to, ref, log } = params;

  const ext = await prisma.extension.findFirst({
    where: { tenantId, number: fromExtension, isActive: true },
    select: { sipAuthUser: true, callerId: true },
  });
  if (!ext) {
    throw new DirectCallError(
      `Extensão ${fromExtension} não existe (ou está inactiva) no PBX do Falaí para este cliente.`
    );
  }

  const targets = [extensionEndpointId(ext.sipAuthUser), extensionWebEndpointId(ext.sipAuthUser)];
  const bridge = await asterisk.createBridge();
  // A partir daqui qualquer saída tem de largar a bridge, senão fica órfã no
  // Asterisk. Ver cleanup().

  // Ao tocar na extensão mostramos o número marcado: é a informação útil para
  // quem atende ("estás a ligar para 9xxxxxxxx"), não o próprio ramal.
  const originated = await Promise.all(
    targets.map((endpointId) =>
      asterisk
        .originateToPjsipEndpoint(endpointId, `direct:${ref}`, to, RING_TIMEOUT_SECS)
        .then((ch) => ch.id)
        .catch((err) => {
          log.warn({ err, endpointId }, "direct_call.originate_leg_failed");
          return null;
        })
    )
  );
  const legIds = originated.filter((id): id is string => id !== null);
  if (legIds.length === 0) {
    await asterisk.destroyBridge(bridge.id).catch(() => {});
    throw new DirectCallError(
      `Não foi possível tocar na extensão ${fromExtension} — nenhum telefone registado (softphone ou webphone).`
    );
  }

  const session: Session = {
    bridgeId: bridge.id,
    channels: new Set(legIds),
    allChannels: new Set(legIds),
    tenantId,
    startedAt: Date.now(),
  };
  // Indexado por todas as pernas: o CRM recebe a primeira, mas o hangup pode
  // chegar com qualquer uma delas.
  for (const id of legIds) sessions.set(id, session);

  asterisk.registerRingGroup(
    legIds,
    (answeredId) => {
      void (async () => {
        try {
          for (const id of legIds) {
            if (id !== answeredId) {
              session.channels.delete(id);
              asterisk.hangup(id).catch(() => {});
            }
          }
          await asterisk.addChannelToBridge(bridge.id, answeredId);

          // Só agora sai para a rede. `dial()` já normaliza o número e escolhe
          // o endpoint do trunk activo (ver AsteriskAdapter.dial).
          const out = await asterisk.dial({ fromExtension, to, ref, autoAnswer: "no", tenantId });
          session.channels.add(out.providerCallId);
          session.allChannels.add(out.providerCallId);
          sessions.set(out.providerCallId, session);

          // Um "ring group" de uma perna só: serve para apanhar o momento em
          // que o destino atende sem que isso vire um CALL_ANSWERED do motor
          // de IA (esta chamada não tem agente).
          asterisk.registerRingGroup(
            [out.providerCallId],
            (destId) => {
              asterisk
                .addChannelToBridge(bridge.id, destId)
                .catch((err) => log.error({ err }, "direct_call.bridge_dest_failed"));
            },
            () => {
              log.info({ ref, to }, "direct_call.destination_no_answer");
              cleanup(asterisk, session, "NO_ANSWER");
            }
          );
        } catch (err) {
          log.error({ err, ref }, "direct_call.outbound_leg_failed");
          cleanup(asterisk, session);
        }
      })();
    },
    () => {
      log.info({ ref, fromExtension }, "direct_call.extension_no_answer");
      cleanup(asterisk, session, "NO_ANSWER");
    }
  );

  return { providerCallId: legIds[0]! };
}

/** Desliga todas as pernas de uma chamada directa e larga a bridge. */
export async function hangupAsteriskDirectCall(
  asterisk: AsteriskAdapter,
  providerCallId: string
): Promise<void> {
  const session = sessions.get(providerCallId);
  if (!session) {
    // Pode ser um id de um motor anterior (ou já limpo) — desligar à mesma.
    await asterisk.hangup(providerCallId).catch(() => {});
    return;
  }
  cleanup(asterisk, session);
}

/** A chamada ainda existe do nosso lado? Usado pelo polling do CRM. */
export function isAsteriskDirectCallActive(providerCallId: string): boolean {
  return sessions.has(providerCallId);
}

/**
 * Desliga as pernas, larga a bridge e fecha o registo da chamada.
 *
 * Os três têm de andar juntos: sem o `destroyBridge` ficava uma bridge ARI viva
 * por cada chamada, e sem o `closeCallRows` um destino que não atende deixava o
 * registo em IN_PROGRESS para sempre (só o hangup explícito do CRM o fechava).
 */
function cleanup(asterisk: AsteriskAdapter, session: Session, outcome: "COMPLETED" | "NO_ANSWER" = "COMPLETED"): void {
  for (const id of session.channels) {
    asterisk.hangup(id).catch(() => {});
  }
  for (const id of session.allChannels) sessions.delete(id);
  session.channels.clear();
  asterisk.destroyBridge(session.bridgeId).catch(() => {});
  void closeCallRows(session, outcome);
}

/** Fecha na base de dados os registos DIRECT que correspondem a esta sessão. */
async function closeCallRows(session: Session, outcome: "COMPLETED" | "NO_ANSWER"): Promise<void> {
  const channelIds = [...session.allChannels];
  if (channelIds.length === 0) return;
  try {
    await prisma.call.updateMany({
      where: {
        tenantId: session.tenantId,
        kind: "DIRECT",
        status: "IN_PROGRESS",
        yeastarCallId: { in: channelIds },
      },
      data: {
        status: outcome,
        outcome,
        endedAt: new Date(),
        // Sem isto a lista do CRM mostrava sempre "0s".
        durationSecs: session.durationSecs ?? 0,
      },
    });
  } catch {
    // Fechar o registo é contabilidade, não pode derrubar a limpeza da chamada.
  }
}

/**
 * Fecha a chamada directa quando o desligar vem do LADO DE LÁ (o destino, ou o
 * próprio webphone) em vez de vir do botão do CRM.
 *
 * Sem isto só a rota /direct/hangup fechava o registo: quem desligava no
 * telemóvel deixava a chamada eternamente "Em curso" na lista, e a bridge e as
 * sessões em memória ficavam para trás até à varredura das 4 horas.
 */
export function registerDirectCallEvents(
  onCallEvent: (handler: (event: CallEvent) => Promise<void>) => void,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): void {
  onCallEvent(async (event) => {
    if (event.type !== "CALL_ENDED" && event.type !== "CALL_FAILED") return;
    const session = sessions.get(event.providerCallId);
    if (!session) return; // não é uma chamada directa nossa

    if (event.type === "CALL_ENDED") session.durationSecs = event.durationSecs;
    log.info(
      { providerCallId: event.providerCallId, type: event.type },
      "direct_call.ended_by_remote"
    );
    // Uma chamada directa tem duas pernas: se uma cai, a outra não tem com quem
    // falar. CALL_FAILED aqui significa que nunca chegou a haver conversa.
    cleanup(asterisk, session, event.type === "CALL_FAILED" ? "NO_ANSWER" : "COMPLETED");
  });
}

/**
 * Varredura periódica: expira sessões esquecidas em memória e reconcilia os
 * registos DIRECT que ficaram pendurados em IN_PROGRESS (por exemplo os de
 * antes de um reinício da API, que perde o mapa de sessões).
 */
export function startDirectCallSweeper(
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      const expired = new Set<Session>();
      for (const session of sessions.values()) {
        if (now - session.startedAt > SESSION_MAX_MS) expired.add(session);
      }
      for (const session of expired) {
        log.warn({ bridgeId: session.bridgeId }, "direct_call.session_expired");
        cleanup(asterisk, session);
      }

      // Registos órfãos: em curso há mais tempo do que uma chamada pode durar e
      // sem sessão viva que os feche.
      try {
        const stale = await prisma.call.updateMany({
          where: {
            kind: "DIRECT",
            status: "IN_PROGRESS",
            createdAt: { lt: new Date(now - SESSION_MAX_MS) },
          },
          data: { status: "NO_ANSWER", outcome: "NO_ANSWER", endedAt: new Date() },
        });
        if (stale.count > 0) log.warn({ count: stale.count }, "direct_call.stale_rows_closed");
      } catch (err) {
        log.warn({ err }, "direct_call.sweep_failed");
      }
    })();
  }, SWEEP_MS);
  timer.unref();
  return timer;
}
