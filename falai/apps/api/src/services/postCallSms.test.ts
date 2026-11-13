import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SMS pós-chamada: a campanha promete "envio-lhe o link por SMS" e a mensagem
 * sai a quem atendeu. Cada SMS é cobrada, por isso o que estes testes guardam é
 * não enviar a quem não atendeu e não enviar duas vezes pela mesma chamada.
 */

type CallRow = {
  tenantId: string;
  toNumber: string | null;
  answeredAt: Date | null;
  contactId: string | null;
  contact: { name: string | null } | null;
  campaign: { postCallSmsText: string | null; postCallSmsSenderId: string | null; tenant: { name: string } } | null;
};

let call: CallRow | null = null;
let already: { id: string } | null = null;

const prisma = {
  call: { findUnique: vi.fn(async () => call) },
  smsMessage: { findFirst: vi.fn(async () => already) },
};
const sendSms = vi.fn(async () => ({ id: "sms_1", status: "SENT", segments: 1, costCents: 0 }));
const getTenantSmsConfig = vi.fn(async (): Promise<{ smsEnabled: boolean; apiKey: string | null; senderId: string | null; pricePerSegmentCents: number }> => ({ smsEnabled: true, apiKey: "k", senderId: "FALAI", pricePerSegmentCents: 0 }));

vi.mock("@falai/db", () => ({ prisma }));
vi.mock("./sms.service.js", () => ({ sendSms, getTenantSmsConfig }));

const { notifyPostCall, renderPostCallText, parsePostCallSms, tenantCanSendSms, POST_CALL_TRIGGER } =
  await import("./postCallSms.service.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const fastify = {} as never;
const notify = (status = "COMPLETED") => notifyPostCall({ fastify, tenantId: "tnt_1", callId: "call_1", status, log });

beforeEach(() => {
  vi.clearAllMocks();
  already = null;
  call = {
    tenantId: "tnt_1",
    toNumber: "+244923111222",
    answeredAt: new Date(),
    contactId: "ct_1",
    contact: { name: "Maria" },
    campaign: {
      postCallSmsText: "Olá {nome}, peça o seu crédito em https://x.ao/c",
      postCallSmsSenderId: "DFACIL",
      tenant: { name: "FÁCIL" },
    },
  };
});

describe("SMS pós-chamada: envio", () => {
  it("envia a quem atendeu, com o remetente da campanha e ligada à chamada", async () => {
    await notify();
    expect(sendSms).toHaveBeenCalledWith(fastify, "tnt_1", {
      to: "+244923111222",
      body: "Olá Maria, peça o seu crédito em https://x.ao/c",
      trigger: POST_CALL_TRIGGER,
      callId: "call_1",
      contactId: "ct_1",
      senderId: "DFACIL",
    });
  });

  it("não envia se a chamada não foi atendida", async () => {
    await notify("NO_ANSWER");
    await notify("FAILED");
    call!.answeredAt = null;
    await notify("COMPLETED");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("não envia se a campanha não tem texto", async () => {
    call!.campaign!.postCallSmsText = null;
    await notify();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("não envia duas vezes pela mesma chamada", async () => {
    already = { id: "sms_0" };
    await notify();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("não envia a chamadas de outro cliente", async () => {
    call!.tenantId = "tnt_2";
    await notify();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("um erro no envio não sai daqui", async () => {
    sendSms.mockRejectedValueOnce(new Error("Saldo insuficiente"));
    await expect(notify()).resolves.toBeUndefined();
  });
});

describe("SMS pós-chamada: texto", () => {
  it("nome vazio não deixa 'Olá , ...'", () => {
    expect(renderPostCallText("Olá {nome}, veja o link.", { nome: "", numero: "9", empresa: "E" })).toBe("Olá, veja o link.");
  });
  it("variável desconhecida fica como está", () => {
    expect(renderPostCallText("{empresa} {outra}", { nome: "", numero: "9", empresa: "E" })).toBe("E {outra}");
  });
});

describe("SMS pós-chamada: validação do pedido", () => {
  it("aceita texto e remetente; null desliga", () => {
    expect(parsePostCallSms({ text: " Olá ", senderId: "DFACIL" })).toEqual({ ok: true, value: { text: "Olá", senderId: "DFACIL" } });
    expect(parsePostCallSms({ text: "Olá" })).toEqual({ ok: true, value: { text: "Olá", senderId: null } });
    expect(parsePostCallSms(null)).toEqual({ ok: true, value: null });
  });
  it("recusa texto vazio, longo demais ou remetente inválido", () => {
    expect(parsePostCallSms({ text: "" }).ok).toBe(false);
    expect(parsePostCallSms({ text: "x".repeat(613) }).ok).toBe(false);
    expect(parsePostCallSms({ text: "Olá", senderId: "REMETENTE_LONGO" }).ok).toBe(false);
    expect(parsePostCallSms("texto" as never).ok).toBe(false);
  });
  it("só aceita campanhas com SMS se o cliente tiver SMS ativo e chave", async () => {
    expect(await tenantCanSendSms("tnt_1")).toBe(true);
    getTenantSmsConfig.mockResolvedValueOnce({ smsEnabled: false, apiKey: "k", senderId: null, pricePerSegmentCents: 0 });
    expect(await tenantCanSendSms("tnt_1")).toBe(false);
    getTenantSmsConfig.mockResolvedValueOnce({ smsEnabled: true, apiKey: null, senderId: null, pricePerSegmentCents: 0 });
    expect(await tenantCanSendSms("tnt_1")).toBe(false);
  });
});
