import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const { sendWithRetry } = await import("./sms.service.js");
const { dedupeByPhone } = await import("./smsCampaign.service.js");
const { isAuthorizedSmsWebhook } = await import("../routes/webhooks/sms.js");

const noWait = async () => {};

describe("sendWithRetry", () => {
  it("429/5xx/timeout: tenta de novo e pára quando passa", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, providerMsgId: null, retryable: true, details: "429" })
      .mockResolvedValueOnce({ accepted: true, providerMsgId: "m1" });
    const r = await sendWithRetry(send, [1, 1], noWait);
    expect(r.accepted).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("esgota as tentativas e devolve a última falha", async () => {
    const send = vi.fn().mockResolvedValue({ accepted: false, providerMsgId: null, retryable: true, details: "503" });
    const r = await sendWithRetry(send, [1, 1], noWait);
    expect(r.accepted).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("401/402/422 não se repetem", async () => {
    const send = vi.fn().mockResolvedValue({ accepted: false, providerMsgId: null, retryable: false, details: "401" });
    await sendWithRetry(send, [1, 1], noWait);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("dedupeByPhone", () => {
  it("tira quem já está na campanha (qualquer formato) e repetidos no lote", () => {
    const contacts = [
      { id: "a", phone: "923456789" },
      { id: "b", phone: "+244 912 345 678" },
      { id: "c", phone: "912345678" },
      { id: "d", phone: null },
      { id: "e", phone: "931111111" },
    ];
    const out = dedupeByPhone(contacts, ["244923456789"]);
    expect(out.map((c) => c.id)).toEqual(["b", "e"]);
  });
});

describe("isAuthorizedSmsWebhook", () => {
  it("sem segredo configurado aceita (comportamento antigo)", () => {
    expect(isAuthorizedSmsWebhook("", undefined)).toBe(true);
  });
  it("com segredo exige o token igual", () => {
    expect(isAuthorizedSmsWebhook("s3cret", "s3cret")).toBe(true);
    expect(isAuthorizedSmsWebhook("s3cret", "errado")).toBe(false);
    expect(isAuthorizedSmsWebhook("s3cret", "s3cre")).toBe(false);
    expect(isAuthorizedSmsWebhook("s3cret", undefined)).toBe(false);
    expect(isAuthorizedSmsWebhook("s3cret", ["s3cret"])).toBe(false);
  });
});
