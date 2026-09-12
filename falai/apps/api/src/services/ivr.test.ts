import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CallEvent } from "@falai/shared";

/**
 * Atendimento automático (IVR). Antes disto uma rota de entrada com destType
 * "IVR" caía no fallback de "sem rota": o valor existia no schema, o dígito já
 * chegava do Asterisk, mas ninguém ligava as duas pontas.
 *
 * O que estes testes fixam é o comportamento que se parte com mais facilidade:
 * a tecla tem de encaminhar para a extensão DAQUELA opção, o anúncio tem de ser
 * cortado por quem prime a tecla, e um menu que ninguém responde não pode
 * deixar o chamador preso nem desligar-lhe a chamada em silêncio.
 */

const MENU = {
  id: "menu_1",
  greetingPrompt: "menu-principal",
  invalidPrompt: "tecla-invalida",
  timeoutSecs: 5,
  maxRetries: 2,
  timeoutDestType: null as string | null,
  timeoutDestValue: null as string | null,
  options: [
    { digit: "1", destType: "EXTENSION", destValue: "201" },
    { digit: "2", destType: "EXTENSION", destValue: "202" },
  ],
};

let menu: typeof MENU | null = MENU;
/** Extensões que existem no cliente → credencial SIP com que o endpoint se chama. */
const extensions: Record<string, string> = { "201": "Ab12", "202": "Cd34" };

const prisma = {
  ivrMenu: { findFirst: vi.fn(async () => menu) },
  extension: {
    findFirst: vi.fn(async ({ where }: any) => {
      const sipAuthUser = extensions[where.number];
      return sipAuthUser ? { sipAuthUser } : null;
    }),
  },
  call: {
    upsert: vi.fn(async () => ({ id: "call_1" })),
    findUnique: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    update: vi.fn(async () => ({})),
  },
  tenant: { findUnique: vi.fn(async () => null), findUniqueOrThrow: vi.fn(async () => ({ balanceCents: 0 })), update: vi.fn(async () => ({})) },
  walletTransaction: { create: vi.fn(async () => ({})) },
};

vi.mock("@falai/db", () => ({ prisma }));
vi.mock("@falai/providers", () => ({
  extensionEndpointId: (s: string) => `ext_${s}`,
  extensionWebEndpointId: (s: string) => `extweb_${s}`,
}));

const resolveInboundForTenant = vi.fn();
const resolveInboundGlobal = vi.fn();
vi.mock("./callRouting.service.js", () => ({ resolveInboundForTenant, resolveInboundGlobal }));
// O SMS de chamada não atendida tem os seus próprios testes; aqui só interessa
// que não arraste o gateway nem a configuração real para dentro destes.
vi.mock("./missedCallSms.service.js", () => ({ notifyMissedCall: vi.fn(async () => {}) }));


// A gravação tem os seus próprios testes; aqui só interessa que não arraste as
// definições do sistema (e, com elas, a configuração real) para dentro destes.
vi.mock("./callRecording.service.js", () => ({
  startCallRecording: vi.fn(async () => {}),
  stopCallRecording: vi.fn(async () => {}),
  saveFinishedRecording: vi.fn(async () => {}),
}));

const { registerInboundCallRouter } = await import("./inboundCallRouter.service.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const CHANNEL = "chan-trunk-1";
const START: CallEvent = {
  type: "INBOUND_CALL_STARTED",
  providerCallId: CHANNEL,
  did: "244959100354",
  callerIdNum: "+244923111222",
  tenantId: "tnt_1",
};

function setup() {
  let handler!: (e: CallEvent) => Promise<void>;
  let playbackSeq = 0;
  const asterisk = {
    answerChannel: vi.fn(async () => {}),
    playMediaOnChannel: vi.fn(async (_channelId: string, _prompt: string) => ({ id: `pb${++playbackSeq}` })),
    stopPlayback: vi.fn(async () => {}),
    noRouteFallback: vi.fn(async () => {}),
    createBridge: vi.fn(async () => ({ id: "br1" })),
    addChannelToBridge: vi.fn(async () => {}),
    originateToPjsipEndpoint: vi.fn(async (endpointId: string) => ({ id: `chan_${endpointId}` })),
    registerRingGroup: vi.fn(),
    destroyBridge: vi.fn(async () => {}),
    hangup: vi.fn(async () => {}),
  };
  registerInboundCallRouter((h) => { handler = h; }, asterisk as never, {} as never, log);
  return { asterisk, emit: (e: CallEvent) => handler(e) };
}

/** Deixa correr as cadeias de promessas disparadas sem await (handleDtmf). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Números das extensões para que a chamada foi efectivamente encaminhada. */
const ringedExtensions = (asterisk: { originateToPjsipEndpoint: { mock: { calls: any[][] } } }) =>
  asterisk.originateToPjsipEndpoint.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  menu = MENU;
  resolveInboundForTenant.mockResolvedValue({ tenantId: "tnt_1", destType: "IVR", destValue: "menu_1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IVR — anúncio", () => {
  it("atende a chamada e toca o anúncio do menu", async () => {
    const s = setup();
    await s.emit(START);

    expect(s.asterisk.answerChannel).toHaveBeenCalledWith(CHANNEL);
    expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledWith(CHANNEL, "menu-principal");
    // Ninguém foi chamado ainda: o menu é que decide.
    expect(s.asterisk.originateToPjsipEndpoint).not.toHaveBeenCalled();
  });

  it("um menu que não existe não deixa a chamada em silêncio", async () => {
    menu = null;
    const s = setup();
    await s.emit(START);

    expect(s.asterisk.playMediaOnChannel).not.toHaveBeenCalled();
    expect(s.asterisk.noRouteFallback).toHaveBeenCalledWith(CHANNEL);
  });

  it("um menu sem teclas nenhumas não prende o chamador a ouvi-lo em ciclo", async () => {
    menu = { ...MENU, options: [] };
    const s = setup();
    await s.emit(START);

    expect(s.asterisk.playMediaOnChannel).not.toHaveBeenCalled();
    expect(s.asterisk.noRouteFallback).toHaveBeenCalledWith(CHANNEL);
  });
});

describe("IVR — tecla premida", () => {
  it("encaminha para a extensão da opção escolhida", async () => {
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "DTMF", providerCallId: CHANNEL, digit: "2" });
    await flush();

    expect(prisma.extension.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ number: "202" }) })
    );
    expect(ringedExtensions(s.asterisk)).toEqual(["ext_Cd34", "extweb_Cd34"]);
  });

  it("corta o anúncio a meio — quem prime a tecla não quer ouvir o resto", async () => {
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "DTMF", providerCallId: CHANNEL, digit: "1" });
    await flush();

    expect(s.asterisk.stopPlayback).toHaveBeenCalledWith("pb1");
  });

  it("tecla que não está no menu repete o anúncio em vez de encaminhar", async () => {
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "DTMF", providerCallId: CHANNEL, digit: "9" });
    await flush();

    expect(s.asterisk.originateToPjsipEndpoint).not.toHaveBeenCalled();
    expect(s.asterisk.playMediaOnChannel.mock.calls.map((c) => c[1])).toEqual([
      "menu-principal",
      "tecla-invalida",
      "menu-principal",
    ]);
  });

  it("a extensão da opção pode ter desaparecido — aí avisa, não fica calado", async () => {
    menu = { ...MENU, options: [{ digit: "1", destType: "EXTENSION", destValue: "999" }] };
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "DTMF", providerCallId: CHANNEL, digit: "1" });
    await flush();

    expect(s.asterisk.originateToPjsipEndpoint).not.toHaveBeenCalled();
    expect(s.asterisk.noRouteFallback).toHaveBeenCalledWith(CHANNEL);
  });

  it("a tecla que chega a meio de uma ronda não deixa o áudio seguinte a tocar", async () => {
    const s = setup();
    let seq = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Entre dois áudios da mesma ronda há uma ida ao Asterisk: prende-se aqui o
    // terceiro pedido para a tecla chegar exactamente nessa fresta.
    s.asterisk.playMediaOnChannel.mockImplementation(async () => {
      seq += 1;
      if (seq === 3) await gate;
      return { id: `pb${seq}` };
    });

    await s.emit(START);
    await s.emit({ type: "DTMF", providerCallId: CHANNEL, digit: "9" });
    await flush();

    await s.emit({ type: "DTMF", providerCallId: CHANNEL, digit: "1" });
    await flush();
    release();
    await flush();

    expect(ringedExtensions(s.asterisk)).toEqual(["ext_Ab12", "extweb_Ab12"]);
    // O anúncio que já ia a caminho tem de ser cortado: sem isto o chamador
    // ouvia o menu outra vez por cima da chamada já encaminhada.
    expect(s.asterisk.stopPlayback).toHaveBeenCalledWith("pb3");
  });

  it("teclas de uma chamada que não está em nenhum menu são ignoradas", async () => {
    const s = setup();
    await s.emit({ type: "DTMF", providerCallId: "chan-de-outra-coisa", digit: "1" });
    await flush();

    expect(s.asterisk.stopPlayback).not.toHaveBeenCalled();
    expect(s.asterisk.noRouteFallback).not.toHaveBeenCalled();
  });
});

describe("IVR — ninguém prime nada", () => {
  it("repete o anúncio e, esgotadas as tentativas, vai para o destino de desistência", async () => {
    vi.useFakeTimers();
    menu = { ...MENU, timeoutDestType: "EXTENSION", timeoutDestValue: "201" };
    const s = setup();
    await s.emit(START);

    // O tempo de espera só arranca quando o anúncio acaba.
    await s.emit({ type: "PROMPT_FINISHED", providerCallId: CHANNEL, playbackId: "pb1" });
    await vi.advanceTimersByTimeAsync(5000);
    // maxRetries 2: toca uma segunda vez em vez de desistir já.
    expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledTimes(2);
    expect(s.asterisk.originateToPjsipEndpoint).not.toHaveBeenCalled();

    await s.emit({ type: "PROMPT_FINISHED", providerCallId: CHANNEL, playbackId: "pb2" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ringedExtensions(s.asterisk)).toEqual(["ext_Ab12", "extweb_Ab12"]);
  });

  it("sem destino de desistência toca o aviso em vez de desligar em silêncio", async () => {
    vi.useFakeTimers();
    menu = { ...MENU, maxRetries: 1 };
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "PROMPT_FINISHED", providerCallId: CHANNEL, playbackId: "pb1" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(s.asterisk.noRouteFallback).toHaveBeenCalledWith(CHANNEL);
  });

  it("o fim de um anúncio já cortado não arranca a contagem da ronda nova", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.emit(START);
    // Tecla inválida: corta o pb1 e arranca pb2 (aviso) + pb3 (anúncio outra vez).
    await s.emit({ type: "DTMF", providerCallId: CHANNEL, digit: "9" });
    await vi.advanceTimersByTimeAsync(0);

    // O PlaybackFinished atrasado do anúncio cortado não pode valer como fim do
    // anúncio que está a tocar agora — se valesse, a espera pela tecla começava
    // com o chamador ainda a ouvir as opções.
    await s.emit({ type: "PROMPT_FINISHED", providerCallId: CHANNEL, playbackId: "pb1" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledTimes(3);
  });
});

describe("IVR — fim da chamada", () => {
  it("desligar a meio do menu não deixa o temporizador vivo", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "PROMPT_FINISHED", providerCallId: CHANNEL, playbackId: "pb1" });
    await s.emit({ type: "CALL_ENDED", providerCallId: CHANNEL, endedAt: new Date(), durationSecs: 3, hangupCause: "NORMAL" });

    await vi.advanceTimersByTimeAsync(10_000);
    // Sem o cancelamento, a repetição do anúncio disparava num canal já morto.
    expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledTimes(1);
  });
});
