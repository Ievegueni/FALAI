/**
 * Atendimento automático (IVR) das chamadas de entrada: toca um anúncio
 * ("para vendas prima 1, para suporte prima 2") e encaminha a chamada para o
 * destino da tecla premida.
 *
 * Até aqui uma InboundRoute com destType "IVR" caía no fallback de "sem rota" —
 * o valor existia no schema mas ninguém o tratava. Os dígitos já chegavam do
 * Asterisk (evento DTMF do AsteriskAdapter), mas eram só registados em log.
 *
 * A máquina de estados de cada chamada vive em memória (o canal também vive, e
 * morre com ele). Não há nada a persistir: uma chamada a meio de um menu não
 * sobrevive a um reinício da API de qualquer maneira, porque o canal fica sem
 * quem o controle.
 */
import type { AsteriskAdapter } from "@falai/providers";
import type { CallEvent } from "@falai/shared";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";

export type InboundEvent = Extract<CallEvent, { type: "INBOUND_CALL_STARTED" }>;

export interface IvrDestination {
  destType: string;
  destValue: string;
}

/** Entrega a chamada ao destino escolhido. Devolve false se não foi possível. */
export type DeliverToDestination = (
  event: InboundEvent,
  tenantId: string,
  dest: IvrDestination
) => Promise<boolean>;

interface MenuOption {
  digit: string;
  destType: string;
  destValue: string;
}

interface Menu {
  id: string;
  greetingPrompt: string;
  invalidPrompt: string | null;
  timeoutSecs: number;
  maxRetries: number;
  timeoutDestType: string | null;
  timeoutDestValue: string | null;
  options: MenuOption[];
}

interface Session {
  event: InboundEvent;
  tenantId: string;
  menu: Menu;
  /**
   * Playbacks da ronda actual que ainda não acabaram. Um anúncio cortado a meio
   * também dispara PlaybackFinished: sem isto, o fim do anúncio ABANDONADO
   * contava como fim do anúncio a tocar e arrancava a contagem do tempo de
   * espera cedo de mais.
   */
  playbackIds: Set<string>;
  timer: NodeJS.Timeout | null;
  /** Quantas vezes o anúncio já tocou (a primeira conta). */
  attempts: number;
  done: boolean;
}

export class IvrEngine {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly asterisk: AsteriskAdapter,
    private readonly log: FastifyBaseLogger,
    private readonly deliver: DeliverToDestination
  ) {}

  /** Há um menu a decorrer neste canal? */
  isActive(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  /**
   * Atende a chamada e começa o menu. `menuId` é o destValue da InboundRoute.
   */
  async start(event: InboundEvent, tenantId: string, menuId: string): Promise<void> {
    const menu = await loadMenu(tenantId, menuId);
    if (!menu) {
      this.log.warn({ tenantId, menuId, did: event.did }, "ivr.menu_not_found");
      await this.asterisk.noRouteFallback(event.providerCallId);
      return;
    }
    if (menu.options.length === 0) {
      // Um menu sem teclas nunca encaminha nada: mais vale o aviso de sempre do
      // que prender o chamador a ouvir um anúncio em ciclo.
      this.log.warn({ tenantId, menuId }, "ivr.menu_without_options");
      await this.asterisk.noRouteFallback(event.providerCallId);
      return;
    }

    const channelId = event.providerCallId;
    await this.asterisk.answerChannel(channelId);

    const session: Session = {
      event,
      tenantId,
      menu,
      playbackIds: new Set(),
      timer: null,
      attempts: 0,
      done: false,
    };
    this.sessions.set(channelId, session);
    this.log.info({ channelId, tenantId, menuId, did: event.did }, "ivr.started");
    await this.playRound(channelId, session, [menu.greetingPrompt]);
  }

  /** Tecla premida. */
  handleDtmf(channelId: string, digit: string): void {
    const session = this.sessions.get(channelId);
    if (!session || session.done) return;
    void this.onDigit(channelId, session, digit);
  }

  /** Um áudio acabou. Só a partir daqui se conta o tempo de espera pela tecla. */
  handlePromptFinished(channelId: string, playbackId?: string): void {
    const session = this.sessions.get(channelId);
    if (!session || session.done) return;

    if (playbackId) {
      // De uma ronda anterior (anúncio cortado): já não interessa.
      if (!session.playbackIds.has(playbackId)) return;
      session.playbackIds.delete(playbackId);
      if (session.playbackIds.size > 0) return;
    } else {
      session.playbackIds = new Set();
    }
    this.armTimer(channelId, session);
  }

  /** A chamada morreu — larga o que houver para não deixar temporizadores vivos. */
  cancel(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    session.done = true;
    this.sessions.delete(channelId);
  }

  private async onDigit(channelId: string, session: Session, digit: string): Promise<void> {
    // Quem prime a tecla não quer ouvir o resto do anúncio.
    await this.stopRound(session);

    const option = session.menu.options.find((o) => o.digit === digit);
    if (!option) {
      this.log.info({ channelId, digit }, "ivr.invalid_digit");
      const prompts = session.menu.invalidPrompt
        ? [session.menu.invalidPrompt, session.menu.greetingPrompt]
        : [session.menu.greetingPrompt];
      await this.retryOrGiveUp(channelId, session, prompts);
      return;
    }

    this.log.info({ channelId, digit, dest: option.destType }, "ivr.digit_matched");
    this.finish(channelId, session);
    await this.route(session, { destType: option.destType, destValue: option.destValue });
  }

  /** Ninguém premiu nada a tempo. */
  private async onTimeout(channelId: string, session: Session): Promise<void> {
    this.log.info({ channelId, attempts: session.attempts }, "ivr.timeout");
    await this.retryOrGiveUp(channelId, session, [session.menu.greetingPrompt]);
  }

  /** Repete o anúncio enquanto houver tentativas; senão vai para o destino de desistência. */
  private async retryOrGiveUp(channelId: string, session: Session, prompts: string[]): Promise<void> {
    if (session.attempts >= session.menu.maxRetries) {
      this.finish(channelId, session);
      await this.giveUp(session);
      return;
    }
    await this.playRound(channelId, session, prompts);
  }

  private async giveUp(session: Session): Promise<void> {
    const { timeoutDestType, timeoutDestValue } = session.menu;
    if (timeoutDestType && timeoutDestValue) {
      await this.route(session, { destType: timeoutDestType, destValue: timeoutDestValue });
      return;
    }
    await this.asterisk.noRouteFallback(session.event.providerCallId).catch(() => {});
  }

  /** Entrega a chamada; se o destino não existir, o chamador não fica em silêncio. */
  private async route(session: Session, dest: IvrDestination): Promise<void> {
    try {
      const ok = await this.deliver(session.event, session.tenantId, dest);
      if (ok) return;
    } catch (err) {
      this.log.error({ err, dest }, "ivr.deliver_failed");
    }
    await this.asterisk.noRouteFallback(session.event.providerCallId).catch(() => {});
  }

  /**
   * Toca uma sequência de áudios e passa a contar como mais uma tentativa. O
   * Asterisk encadeia-os no canal pela ordem em que são pedidos.
   */
  private async playRound(channelId: string, session: Session, prompts: string[]): Promise<void> {
    session.attempts += 1;
    // O próprio Set identifica a ronda. Entre dois pedidos de áudio há uma ida
    // ao Asterisk pelo meio, e é nessa fresta que a tecla pode chegar: sem esta
    // verificação o áudio seguinte ainda era pedido, e o chamador ouvia o resto
    // do menu já depois de a chamada ter sido encaminhada.
    const round = new Set<string>();
    session.playbackIds = round;
    try {
      for (const prompt of prompts) {
        const playback = await this.asterisk.playMediaOnChannel(channelId, prompt);
        if (session.playbackIds !== round || session.done) {
          await this.asterisk.stopPlayback(playback.id).catch(() => {});
          return;
        }
        round.add(playback.id);
      }
    } catch (err) {
      // Sem áudio o menu não se percebe — não vale a pena deixar o chamador à
      // espera de uma pergunta que nunca ouviu.
      this.log.error({ err, channelId }, "ivr.playback_failed");
      this.finish(channelId, session);
      await this.asterisk.noRouteFallback(channelId).catch(() => {});
    }
  }

  /** Corta o que estiver a tocar e desarma a espera. */
  private async stopRound(session: Session): Promise<void> {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    const ids = [...session.playbackIds];
    // Set novo (e não .clear()): é a troca de identidade que diz ao playRound a
    // decorrer que a ronda dele já não é a actual.
    session.playbackIds = new Set();
    await Promise.all(ids.map((id) => this.asterisk.stopPlayback(id).catch(() => {})));
  }

  private armTimer(channelId: string, session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = null;
      void this.onTimeout(channelId, session);
    }, session.menu.timeoutSecs * 1000);
  }

  private finish(channelId: string, session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.done = true;
    this.sessions.delete(channelId);
  }
}

async function loadMenu(tenantId: string, menuId: string): Promise<Menu | null> {
  // Filtra pelo tenant de propósito: o id vem de uma InboundRoute e um menu de
  // outro cliente nunca pode atender a chamada deste.
  const menu = await prisma.ivrMenu.findFirst({
    where: { id: menuId, tenantId },
    select: {
      id: true,
      greetingPrompt: true,
      invalidPrompt: true,
      timeoutSecs: true,
      maxRetries: true,
      timeoutDestType: true,
      timeoutDestValue: true,
      options: { select: { digit: true, destType: true, destValue: true } },
    },
  });
  return menu;
}
