import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CallEvent } from "@falai/shared";

/**
 * Gravação de chamadas. O campo Call.recordingUrl e o leitor de áudio do CRM já
 * existiam há muito, mas nada gravava nem escrevia o campo.
 *
 * O que estes testes prendem é sobretudo aquilo que, se se partir, só se
 * descobre tarde e mal: gravar um cliente que não pediu para ser gravado,
 * gravar sem o aviso que o cliente configurou, ou ficar com o ficheiro sem
 * ninguém o conseguir ouvir.
 */

const CHANNEL = "chan-trunk-1";
const CALL_ID = "call_1";

let tenant = { recordCalls: true, recordingAnnounce: false };
let settings: Record<string, string | null> = {
  RECORDING_DIR: "/var/falai/recordings",
  RECORDING_FORMAT: null,
  RECORDING_ANNOUNCE_PROMPT: null,
};

const calls: { id: string; recordingUrl: string | null; kind: string; tenantId: string; answeredAt: Date | null; status: string }[] = [];

const prisma = {
  call: {
    upsert: vi.fn(async () => ({ id: CALL_ID })),
    findUnique: vi.fn(async () => calls[0] ?? null),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const matched = calls.filter((c) => (where.id ? c.id === where.id : true));
      for (const c of matched) Object.assign(c, data);
      return { count: matched.length };
    }),
    update: vi.fn(async () => ({})),
  },
  extension: { findFirst: vi.fn(async () => ({ sipAuthUser: "Ab12" })) },
  tenant: {
    findUnique: vi.fn(async () => tenant),
    findUniqueOrThrow: vi.fn(async () => ({ balanceCents: 0 })),
    update: vi.fn(async () => ({})),
  },
  walletTransaction: { create: vi.fn(async () => ({})) },
};

vi.mock("@falai/db", () => ({ prisma }));
vi.mock("@falai/providers", () => ({
  extensionEndpointId: (s: string) => `ext_${s}`,
  extensionWebEndpointId: (s: string) => `extweb_${s}`,
}));
vi.mock("./settings.service.js", () => ({
  getSetting: vi.fn(async (key: string) => settings[key] ?? null),
}));

const resolveInboundForTenant = vi.fn();
const resolveInboundGlobal = vi.fn();
vi.mock("./callRouting.service.js", () => ({ resolveInboundForTenant, resolveInboundGlobal }));
// O SMS de chamada não atendida tem os seus próprios testes; aqui só interessa
// que não arraste o gateway nem a configuração real para dentro destes.
vi.mock("./missedCallSms.service.js", () => ({ notifyMissedCall: vi.fn(async () => {}) }));


const { registerInboundCallRouter } = await import("./inboundCallRouter.service.js");
const { recordingSettings, DEFAULT_RECORDING_FORMAT, DEFAULT_ANNOUNCE_PROMPT } =
  await import("./callRecording.service.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function setup() {
  let handler!: (e: CallEvent) => Promise<void>;
  const answered: ((id: string) => void)[] = [];
  const asterisk = {
    createBridge: vi.fn(async () => ({ id: "br1" })),
    answerChannel: vi.fn(async () => {}),
    addChannelToBridge: vi.fn(async () => {}),
    originateToPjsipEndpoint: vi.fn(async (endpointId: string) => ({ id: `chan_${endpointId}` })),
    registerRingGroup: vi.fn((_ids: string[], onAnswer: (id: string) => void) => { answered.push(onAnswer); }),
    recordBridge: vi.fn(async (_b: string, _n: string, _f: string) => {}),
    stopRecording: vi.fn(async (_name: string) => {}),
    playMediaOnBridge: vi.fn(async (_b: string, _p: string) => ({ id: "pb1" })),
    playMediaOnChannel: vi.fn(async () => ({ id: "pb1" })),
    stopPlayback: vi.fn(async () => {}),
    noRouteFallback: vi.fn(async () => {}),
    destroyBridge: vi.fn(async () => {}),
    hangup: vi.fn(async () => {}),
  };
  registerInboundCallRouter((h) => { handler = h; }, asterisk as never, {} as never, log);
  return { asterisk, emit: (e: CallEvent) => handler(e), answer: () => answered[0]!("chan_ext_Ab12") };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const START: CallEvent = {
  type: "INBOUND_CALL_STARTED",
  providerCallId: CHANNEL,
  did: "244959100354",
  callerIdNum: "+244923111222",
  tenantId: "tnt_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  tenant = { recordCalls: true, recordingAnnounce: false };
  settings = {
    RECORDING_DIR: "/var/falai/recordings",
    RECORDING_FORMAT: null,
    RECORDING_ANNOUNCE_PROMPT: null,
  };
  calls.length = 0;
  calls.push({ id: CALL_ID, recordingUrl: null, kind: "INBOUND", tenantId: "tnt_1", answeredAt: null, status: "RINGING" });
  resolveInboundForTenant.mockResolvedValue({ tenantId: "tnt_1", destType: "EXTENSION", destValue: "201" });
});

describe("gravação — quando grava", () => {
  it("grava a bridge, não o canal — um canal só traz um dos lados", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await flush();

    expect(s.asterisk.recordBridge).toHaveBeenCalledWith("br1", CALL_ID, DEFAULT_RECORDING_FORMAT);
  });

  it("só começa a gravar depois de alguém atender", async () => {
    const s = setup();
    await s.emit(START);
    await flush();

    // A tocar ainda não é conversa: gravar aqui dava um ficheiro de sinal de chamada.
    expect(s.asterisk.recordBridge).not.toHaveBeenCalled();
  });

  it("um cliente que não pediu gravação não é gravado", async () => {
    tenant = { recordCalls: false, recordingAnnounce: false };
    const s = setup();
    await s.emit(START);
    s.answer();
    await flush();

    expect(s.asterisk.recordBridge).not.toHaveBeenCalled();
  });

  it("sem pasta configurada não se grava — o ficheiro ficaria fora do alcance da API", async () => {
    settings.RECORDING_DIR = "";
    const s = setup();
    await s.emit(START);
    s.answer();
    await flush();

    expect(s.asterisk.recordBridge).not.toHaveBeenCalled();
  });
});

describe("gravação — aviso ao chamador", () => {
  it("com o aviso ligado, toca-o na bridge para os dois lados ouvirem", async () => {
    tenant = { recordCalls: true, recordingAnnounce: true };
    const s = setup();
    await s.emit(START);
    s.answer();
    await flush();

    expect(s.asterisk.playMediaOnBridge).toHaveBeenCalledWith("br1", DEFAULT_ANNOUNCE_PROMPT);
    // O aviso toca DEPOIS de a gravação arrancar, para ficar dentro do ficheiro
    // e servir de prova de que foi dado.
    const recordOrder = s.asterisk.recordBridge.mock.invocationCallOrder[0]!;
    const announceOrder = s.asterisk.playMediaOnBridge.mock.invocationCallOrder[0]!;
    expect(recordOrder).toBeLessThan(announceOrder);
  });

  it("sem o aviso ligado, não toca nada", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await flush();

    expect(s.asterisk.playMediaOnBridge).not.toHaveBeenCalled();
  });
});

describe("gravação — fim da chamada", () => {
  it("fecha a gravação quando o canal do trunk morre", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await flush();
    await s.emit({ type: "CALL_ENDED", providerCallId: CHANNEL, endedAt: new Date(), durationSecs: 30, hangupCause: "NORMAL" });

    // Sem isto o ficheiro ficava aberto até alguém destruir a bridge.
    expect(s.asterisk.stopRecording).toHaveBeenCalledWith(CALL_ID);
  });

  it("liga o ficheiro à chamada quando a gravação termina", async () => {
    const s = setup();
    await s.emit({ type: "RECORDING_FINISHED", recordingName: CALL_ID, format: "ogg" });

    expect(calls[0]!.recordingUrl).toBe(`${CALL_ID}.ogg`);
  });

  it("uma gravação sem chamada não rebenta nem inventa linhas", async () => {
    calls.length = 0;
    const s = setup();
    await s.emit({ type: "RECORDING_FINISHED", recordingName: "desconhecida", format: "ogg" });

    expect(calls).toHaveLength(0);
  });
});

describe("gravação — definições", () => {
  it("usa ogg por defeito: seis vezes menor que wav e o browser toca-o", async () => {
    expect((await recordingSettings()).format).toBe("ogg");
  });

  it("um formato que o Asterisk não grava é ignorado em vez de ir parar ao caminho do ficheiro", async () => {
    settings.RECORDING_FORMAT = "../../etc/passwd";
    expect((await recordingSettings()).format).toBe(DEFAULT_RECORDING_FORMAT);
  });

  it("um nome de aviso com caminho lá dentro é ignorado", async () => {
    settings.RECORDING_ANNOUNCE_PROMPT = "../../../etc/shadow";
    expect((await recordingSettings()).announcePrompt).toBe(DEFAULT_ANNOUNCE_PROMPT);
  });

  it("aceita os valores válidos que o operador configurar", async () => {
    settings.RECORDING_FORMAT = "wav";
    settings.RECORDING_ANNOUNCE_PROMPT = "aviso_pt";
    const s = await recordingSettings();
    expect(s.format).toBe("wav");
    expect(s.announcePrompt).toBe("aviso_pt");
  });
});
