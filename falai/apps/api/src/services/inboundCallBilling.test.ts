import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CallEvent } from "@falai/shared";

/**
 * Facturação das chamadas de ENTRADA (trunk de peering). Antes, o router
 * encaminhava a chamada e mais nada: sem linha na tabela Call ela não aparecia
 * ao cliente nem contava para o consumo. Estes testes fixam as três regras que
 * mais facilmente se partem outra vez — só se cobra conversa real, só se cobra
 * uma vez, e uma chamada sem rota não custa nada.
 */

interface CallRow {
  id: string;
  tenantId: string;
  kind: string;
  status: string;
  outcome?: string | null;
  toNumber: string;
  fromNumber?: string | null;
  yeastarCallId: string;
  answeredAt?: Date | null;
  endedAt?: Date | null;
  durationSecs: number;
  billedSecs: number;
  costCents: number;
}

const rows: CallRow[] = [];
const wallet: { amountCents: number; reference: string }[] = [];
let balanceCents = 10_000;
let seq = 0;

const byUid = (uid: string) => rows.find((r) => r.yeastarCallId === uid);

const tenantRow = { holdAudio: false };
const prisma = {
  call: {
    upsert: vi.fn(async ({ where, create }: any) => {
      const found = byUid(where.yeastarCallId);
      if (found) return found;
      const row: CallRow = {
        id: `call_${++seq}`,
        durationSecs: 0,
        billedSecs: 0,
        costCents: 0,
        answeredAt: null,
        ...create,
      };
      rows.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => byUid(where.yeastarCallId) ?? null),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const matched = rows.filter((r) => {
        if (where.id && r.id !== where.id) return false;
        if (where.yeastarCallId && r.yeastarCallId !== where.yeastarCallId) return false;
        if (where.kind && r.kind !== where.kind) return false;
        if (typeof where.status === "string" && r.status !== where.status) return false;
        if (where.status?.in && !where.status.in.includes(r.status)) return false;
        return true;
      });
      for (const r of matched) Object.assign(r, data);
      return { count: matched.length };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
  },
  extension: {
    findFirst: vi.fn(async () => ({ sipAuthUser: "Ab12" })),
  },
  extensionGroupMember: {
    findMany: vi.fn(async () => [{ extension: { sipAuthUser: "G1" } }, { extension: { sipAuthUser: "G2" } }]),
  },
  ivrMenu: {
    findFirst: vi.fn(async () => ({
      id: "ivr1",
      timeoutSecs: 5,
      maxRetries: 1,
      options: [
        { digit: "1", destType: "EXTENSION", destValue: "201" },
        { digit: "2", destType: "GROUP", destValue: "grp1" },
      ],
    })),
  },
  tenant: {
    findUnique: vi.fn(async () => ({
      billingModeOverride: null,
      plan: { billingMode: "PER_MINUTE", pricePerMinuteCents: 30, pricePerCallCents: 100 },
      holdAudio: tenantRow.holdAudio,
    })),
    findUniqueOrThrow: vi.fn(async () => ({ balanceCents })),
    update: vi.fn(async () => ({})),
  },
  walletTransaction: {
    create: vi.fn(async ({ data }: any) => {
      wallet.push({ amountCents: data.amountCents, reference: data.reference });
      return data;
    }),
  },
  $executeRaw: vi.fn(async (_s: unknown, ..._v: unknown[]) => {
    balanceCents -= 0;
    return 1;
  }),
};

vi.mock("@falai/db", () => ({ prisma }));
vi.mock("@falai/providers", () => ({
  extensionEndpointId: (s: string) => `ext_${s}`,
  extensionWebEndpointId: (s: string) => `extweb_${s}`,
  holdMusicClass: (s: string) => `falai_${s}`,
}));

const resolveInboundForTenant = vi.fn();
const resolveInboundGlobal = vi.fn();
vi.mock("./callRouting.service.js", () => ({ resolveInboundForTenant, resolveInboundGlobal }));
// Quem decide o texto e o travão de custos é o missedCallSms.service, que tem
// os seus próprios testes. O que se prende aqui é só QUANDO o router o chama.
const notifyMissedCall = vi.fn(async () => {});
vi.mock("./missedCallSms.service.js", () => ({ notifyMissedCall }));


// A gravação tem os seus próprios testes; aqui só interessa que não arraste as
// definições do sistema (e, com elas, a configuração real) para dentro destes.
vi.mock("./callRecording.service.js", () => ({
  startCallRecording: vi.fn(async () => {}),
  stopCallRecording: vi.fn(async () => {}),
  saveFinishedRecording: vi.fn(async () => {}),
}));

const { registerInboundCallRouter } = await import("./inboundCallRouter.service.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/** Monta o router e devolve o disparador de eventos e o adaptador falso. */
function setup() {
  let handler!: (e: CallEvent) => Promise<void>;
  const answered: ((id: string) => void)[] = [];
  const noAnswer: (() => void)[] = [];
  const asterisk = {
    createBridge: vi.fn(async () => ({ id: "br1" })),
    answerChannel: vi.fn(async () => {}),
    addChannelToBridge: vi.fn(async () => {}),
    originateToPjsipEndpoint: vi.fn(async (endpointId: string) => ({ id: `chan_${endpointId}` })),
    registerRingGroup: vi.fn((_ids: string[], onAnswer: (id: string) => void, onAllFailed: () => void) => {
      answered.push(onAnswer);
      noAnswer.push(onAllFailed);
    }),
    noRouteFallback: vi.fn(async () => {}),
    destroyBridge: vi.fn(async () => {}),
    hangup: vi.fn(async () => {}),
    playMediaOnChannel: vi.fn(async () => ({ id: "pb1" })),
    stopPlayback: vi.fn(async () => {}),
    startRingback: vi.fn(async () => ({ id: "rb1" })),
    startBridgeMoh: vi.fn(async () => {}),
    stopBridgeMoh: vi.fn(async () => {}),
  };
  registerInboundCallRouter((h) => { handler = h; }, asterisk as never, {} as never, log);
  return {
    asterisk,
    emit: (e: CallEvent) => handler(e),
    answer: () => answered[0]!("chan_ext_Ab12"),
    nobodyAnswers: () => noAnswer[0]!(),
  };
}

const START: CallEvent = {
  type: "INBOUND_CALL_STARTED",
  providerCallId: "chan-trunk-1",
  did: "220001",
  callerIdNum: "+244923111222",
  tenantId: "tnt_1",
};

beforeEach(() => {
  rows.length = 0;
  wallet.length = 0;
  balanceCents = 10_000;
  seq = 0;
  vi.clearAllMocks();
  resolveInboundForTenant.mockResolvedValue({ tenantId: "tnt_1", destType: "EXTENSION", destValue: "201" });
});

describe("chamada de entrada — registo", () => {
  it("cria a linha com o DID como destino e o chamador como origem", async () => {
    const s = setup();
    await s.emit(START);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: "tnt_1",
      kind: "INBOUND",
      status: "RINGING",
      toNumber: "220001",
      fromNumber: "+244923111222",
      yeastarCallId: "chan-trunk-1",
    });
  });

  it("sem rota não regista nem cobra", async () => {
    resolveInboundForTenant.mockResolvedValue(null);
    const s = setup();
    await s.emit(START);
    expect(rows).toHaveLength(0);
    expect(s.asterisk.noRouteFallback).toHaveBeenCalled();

    await s.emit({ type: "CALL_ENDED", providerCallId: "chan-trunk-1", endedAt: new Date(), durationSecs: 12, hangupCause: "NORMAL" });
    expect(wallet).toHaveLength(0);
  });

  it("o mesmo providerCallId não gera duas linhas", async () => {
    const s = setup();
    await s.emit(START);
    await s.emit(START);
    expect(rows).toHaveLength(1);
  });
});

describe("chamada de entrada — cobrança", () => {
  it("cobra o tempo desde o atendimento, não o do canal do trunk", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await Promise.resolve();
    // Atendida há 90s; o canal do trunk vive há muito mais (foi atendido por nós
    // logo no início) — o que se cobra é a conversa.
    rows[0]!.answeredAt = new Date(Date.now() - 90_000);
    await s.emit({ type: "CALL_ENDED", providerCallId: "chan-trunk-1", endedAt: new Date(), durationSecs: 300, hangupCause: "NORMAL" });

    expect(rows[0]!.status).toBe("COMPLETED");
    expect(rows[0]!.billedSecs).toBeGreaterThanOrEqual(89);
    // PER_MINUTE: 90s → 2 minutos × 30 = 60
    expect(rows[0]!.costCents).toBe(60);
    expect(wallet).toEqual([{ amountCents: -60, reference: rows[0]!.id }]);
  });

  it("não atendida fecha como NO_ANSWER e não custa nada", async () => {
    const s = setup();
    await s.emit(START);
    s.nobodyAnswers();
    await s.emit({ type: "CALL_ENDED", providerCallId: "chan-trunk-1", endedAt: new Date(), durationSecs: 25, hangupCause: "NORMAL" });

    expect(rows[0]!.status).toBe("NO_ANSWER");
    expect(rows[0]!.costCents).toBe(0);
    expect(wallet).toHaveLength(0);
  });

  it("um segundo evento terminal não cobra outra vez", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await Promise.resolve();
    rows[0]!.answeredAt = new Date(Date.now() - 30_000);
    const ended: CallEvent = { type: "CALL_ENDED", providerCallId: "chan-trunk-1", endedAt: new Date(), durationSecs: 40, hangupCause: "NORMAL" };
    await s.emit(ended);
    await s.emit(ended);
    await s.emit({ type: "CALL_FAILED", providerCallId: "chan-trunk-1", reason: "x" });

    expect(wallet).toHaveLength(1);
    expect(rows[0]!.costCents).toBe(30);
  });
});

describe("chamada de entrada — SMS de não atendida", () => {
  const ended: CallEvent = {
    type: "CALL_ENDED", providerCallId: "chan-trunk-1", endedAt: new Date(), durationSecs: 25, hangupCause: "NORMAL",
  };

  it("tocou numa extensão e ninguém atendeu: responde-se ao chamador", async () => {
    const s = setup();
    await s.emit(START);
    s.nobodyAnswers();
    await s.emit(ended);

    expect(notifyMissedCall).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tnt_1", toNumber: "+244923111222" })
    );
  });

  it("desligou dentro do IVR sem nunca fazer tocar ninguém: não se responde", async () => {
    // Ninguém era suposto atendê-lo ainda — pedir desculpa por SMS (e cobrá-lo
    // ao cliente) seria errado.
    resolveInboundForTenant.mockResolvedValue({ tenantId: "tnt_1", destType: "IVR", destValue: "menu_1" });
    const s = setup();
    await s.emit(START);
    await s.emit(ended);

    expect(notifyMissedCall).not.toHaveBeenCalled();
  });

  it("chamada atendida não gera SMS nenhum", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await Promise.resolve();
    rows[0]!.answeredAt = new Date(Date.now() - 30_000);
    await s.emit(ended);

    expect(notifyMissedCall).not.toHaveBeenCalled();
  });
});

describe("IVR", () => {
  const ID = "chan-trunk-1";
  beforeEach(() => {
    resolveInboundForTenant.mockResolvedValue({ tenantId: "tnt_1", destType: "IVR", destValue: "ivr1" });
  });

  it("toca a saudação e encaminha pelo dígito para a extensão", async () => {
    const s = setup();
    await s.emit(START);
    expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledWith(ID, "ivr_ivr1");
    expect(rows).toHaveLength(1); // a chamada chegou ao cliente: fica registada
    expect(s.asterisk.originateToPjsipEndpoint).not.toHaveBeenCalled();

    await s.emit({ type: "DTMF", providerCallId: ID, digit: "1" });
    expect(s.asterisk.stopPlayback).toHaveBeenCalledWith("pb1");
    const targets = s.asterisk.originateToPjsipEndpoint.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(["ext_Ab12", "extweb_Ab12"]);
  });

  it("opção de grupo toca em todos os membros", async () => {
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "DTMF", providerCallId: ID, digit: "2" });
    const targets = s.asterisk.originateToPjsipEndpoint.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(["ext_G1", "extweb_G1", "ext_G2", "extweb_G2"]);
  });

  it("dígito inválido repete; esgotadas as tentativas cai no aviso", async () => {
    const s = setup();
    await s.emit(START);
    await s.emit({ type: "DTMF", providerCallId: ID, digit: "9" });
    expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledTimes(2);
    expect(s.asterisk.noRouteFallback).not.toHaveBeenCalled();

    await s.emit({ type: "DTMF", providerCallId: ID, digit: "9" }); // maxRetries = 1
    expect(s.asterisk.noRouteFallback).toHaveBeenCalledWith(ID);
    // Depois de desistir, dígitos já não fazem nada.
    await s.emit({ type: "DTMF", providerCallId: ID, digit: "1" });
    expect(s.asterisk.originateToPjsipEndpoint).not.toHaveBeenCalled();
  });

  it("silêncio depois da saudação repete ao fim do timeout", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      await s.emit(START);
      await s.emit({ type: "PROMPT_FINISHED", providerCallId: ID, playbackId: "pb1" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("desligar a meio do menu não deixa o timer a correr", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      await s.emit(START);
      await s.emit({ type: "PROMPT_FINISHED", providerCallId: ID, playbackId: "pb1" });
      await s.emit({ type: "CALL_ENDED", providerCallId: ID, endedAt: new Date(), durationSecs: 3, hangupCause: "NORMAL" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(s.asterisk.playMediaOnChannel).toHaveBeenCalledTimes(1);
      expect(rows[0]!.status).toBe("NO_ANSWER");
      expect(wallet).toHaveLength(0); // tempo no menu não se cobra
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chamada de entrada — o que ouve quem liga enquanto toca", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => { tenantRow.holdAudio = false; });

  it("sem música de espera: sinal de chamada, parado antes de ligar o agente", async () => {
    const s = setup();
    await s.emit(START);
    expect(s.asterisk.startRingback).toHaveBeenCalledWith("chan-trunk-1");
    expect(s.asterisk.startBridgeMoh).not.toHaveBeenCalled();
    s.answer();
    await tick();
    expect(s.asterisk.stopPlayback).toHaveBeenCalledWith("rb1");
  });

  it("com música de espera: toca a classe do cliente na bridge e pára antes de o agente entrar", async () => {
    tenantRow.holdAudio = true;
    const s = setup();
    await s.emit(START);
    expect(s.asterisk.startBridgeMoh).toHaveBeenCalledWith("br1", "falai_tnt_1");
    expect(s.asterisk.startRingback).not.toHaveBeenCalled();
    s.answer();
    await tick();
    const stopAt = s.asterisk.stopBridgeMoh.mock.invocationCallOrder[0]!;
    const joinAt = s.asterisk.addChannelToBridge.mock.invocationCallOrder.at(-1)!;
    expect(stopAt).toBeLessThan(joinAt);
  });

  it("se a música falhar, cai no sinal de chamada", async () => {
    tenantRow.holdAudio = true;
    const s = setup();
    s.asterisk.startBridgeMoh.mockRejectedValueOnce(new Error("no class"));
    await s.emit(START);
    expect(s.asterisk.startRingback).toHaveBeenCalled();
  });
});

describe("chamada de entrada — alguém desliga", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const END = (id: string): CallEvent => ({ type: "CALL_ENDED", providerCallId: id, endedAt: new Date(), durationSecs: 5, hangupCause: "NORMAL" });

  it("quem liga desliga a meio do toque: cancela os toques das extensões e desfaz a bridge", async () => {
    const s = setup();
    await s.emit(START);
    await s.emit(END("chan-trunk-1"));
    const hung = (s.asterisk.hangup.mock.calls as unknown[][]).map((c) => c[0]);
    expect(hung).toEqual(expect.arrayContaining(["chan_ext_Ab12", "chan_extweb_Ab12"]));
    expect(s.asterisk.destroyBridge).toHaveBeenCalledWith("br1");
    // O fim dos toques cancelados não é "ninguém atendeu": nada de aviso.
    s.nobodyAnswers();
    expect(s.asterisk.noRouteFallback).not.toHaveBeenCalled();
  });

  it("quem liga desliga depois de atender: desliga o agente", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await tick();
    await s.emit(END("chan-trunk-1"));
    expect((s.asterisk.hangup.mock.calls as unknown[][]).map((c) => c[0])).toContain("chan_ext_Ab12");
  });

  it("o agente desliga: desliga quem ligou", async () => {
    const s = setup();
    await s.emit(START);
    s.answer();
    await tick();
    s.asterisk.hangup.mockClear();
    await s.emit(END("chan_ext_Ab12"));
    expect(s.asterisk.hangup).toHaveBeenCalledWith("chan-trunk-1");
  });
});
