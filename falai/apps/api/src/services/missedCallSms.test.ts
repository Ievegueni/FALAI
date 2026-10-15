import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SMS automático de chamada não atendida.
 *
 * O módulo de SMS já existia por inteiro, mas nada no projecto reagia ao
 * resultado de uma chamada. Cada mensagem destas é COBRADA ao cliente, por isso
 * o que estes testes guardam é sobretudo o que custa dinheiro quando corre mal:
 * enviar a quem não pediu, enviar cinco vezes a quem ligou cinco vezes, ou
 * gastar saldo a mandar SMS para uma extensão interna.
 */

let tenant: { missedCallSms: boolean; missedCallSmsText: string | null; name: string } | null = null;
/** Mensagens automáticas já enviadas, como se estivessem na base de dados. */
let recentAuto: { id: string } | null = null;

const prisma = {
  tenant: { findUnique: vi.fn(async () => tenant) },
  smsMessage: { findFirst: vi.fn(async () => recentAuto) },
};

const sendSms = vi.fn(async () => ({ id: "sms_1", status: "SENT", segments: 1, costCents: 10 }));

vi.mock("@falai/db", () => ({ prisma }));
vi.mock("./sms.service.js", () => ({ sendSms }));

const { notifyMissedCall, renderMissedCallText, isSmsReachable, MISSED_CALL_TRIGGER } =
  await import("./missedCallSms.service.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const fastify = {} as never;

const notify = (toNumber: string | null | undefined) =>
  notifyMissedCall({ fastify, tenantId: "tnt_1", toNumber, callId: "call_1", log });

beforeEach(() => {
  vi.clearAllMocks();
  recentAuto = null;
  tenant = {
    missedCallSms: true,
    missedCallSmsText: "Ligou para a {empresa} e não atendemos. Retornamos já.",
    name: "Clínica Sol",
  };
});

describe("SMS de chamada não atendida — quem recebe", () => {
  it("envia a quem ficou sem resposta, marcado como automático", async () => {
    await notify("+244923111222");

    expect(sendSms).toHaveBeenCalledWith(fastify, "tnt_1", {
      to: "+244923111222",
      body: "Ligou para a Clínica Sol e não atendemos. Retornamos já.",
      trigger: MISSED_CALL_TRIGGER,
    });
  });

  it("um cliente que não pediu o aviso não gasta saldo nenhum", async () => {
    tenant!.missedCallSms = false;
    await notify("+244923111222");

    expect(sendSms).not.toHaveBeenCalled();
  });

  it("com o aviso ligado mas sem mensagem escrita, não envia nada vazio", async () => {
    tenant!.missedCallSmsText = "   ";
    await notify("+244923111222");

    expect(sendSms).not.toHaveBeenCalled();
  });

  it("não manda SMS para uma extensão interna", async () => {
    // "201" é um ramal, não um telemóvel: o envio nunca chegaria a lado nenhum
    // e o cliente pagava na mesma.
    await notify("201");

    expect(sendSms).not.toHaveBeenCalled();
  });

  it("não manda SMS quando o chamador é anónimo", async () => {
    await notify(null);

    expect(sendSms).not.toHaveBeenCalled();
  });
});

describe("SMS de chamada não atendida — travão de custos", () => {
  it("quem liga outra vez no mesmo dia não gera um segundo SMS", async () => {
    recentAuto = { id: "sms_anterior" };
    await notify("+244923111222");

    expect(sendSms).not.toHaveBeenCalled();
  });

  it("o travão só conta os automáticos — um envio manual não cala o aviso", async () => {
    await notify("+244923111222");

    expect(prisma.smsMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ trigger: MISSED_CALL_TRIGGER }),
      })
    );
  });
});

describe("SMS de chamada não atendida — falhas", () => {
  it("um envio que rebenta não pode estragar o fecho da chamada", async () => {
    sendSms.mockRejectedValueOnce(new Error("Saldo insuficiente"));

    // Sem o try/catch no serviço, isto derrubava quem fecha a chamada.
    await expect(notify("+244923111222")).resolves.toBeUndefined();
  });
});

describe("SMS de chamada não atendida — texto", () => {
  it("substitui as variáveis conhecidas", () => {
    const out = renderMissedCallText("{empresa}: ligámos para {numero}.", {
      numero: "+244923111222",
      empresa: "Clínica Sol",
    });
    expect(out).toBe("Clínica Sol: ligámos para +244923111222.");
  });

  it("uma variável que não existe fica como está, em vez de virar 'undefined'", () => {
    const out = renderMissedCallText("Olá {inexistente}", { numero: "1", empresa: "X" });
    expect(out).toBe("Olá {inexistente}");
  });
});

describe("SMS de chamada não atendida — números alcançáveis", () => {
  it("aceita números com separadores e prefixo internacional", () => {
    expect(isSmsReachable("+244 923 111 222")).toBe(true);
  });

  it("recusa ramais e valores vazios", () => {
    expect(isSmsReachable("201")).toBe(false);
    expect(isSmsReachable("")).toBe(false);
    expect(isSmsReachable(null)).toBe(false);
  });
});
