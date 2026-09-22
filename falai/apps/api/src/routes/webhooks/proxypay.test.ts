import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@falai/db", () => ({ prisma: {} }));
vi.mock("../../services/providerConfig.service.js", () => ({ resolveProviderConfig: vi.fn() }));

const { isAuthenticProxyPayRequest } = await import("./proxypay.js");

const KEY = "chave-proxypay";
const body = JSON.stringify({ id: "pay_1", reference: "123", amount: "1000.00", custom_data: { tenantId: "tnt_1" } });
const sign = (raw: string, key = KEY) => createHmac("sha256", key).update(raw).digest("hex");
const basic = (key: string) => `Basic ${Buffer.from(`${key}:`).toString("base64")}`;

describe("isAuthenticProxyPayRequest", () => {
  it("sem chave configurada recusa sempre, mesmo com assinatura", () => {
    expect(isAuthenticProxyPayRequest("", body, { "x-signature": sign(body, "") })).toBe(false);
    expect(isAuthenticProxyPayRequest("", body, {})).toBe(false);
  });

  it("sem header de autenticação recusa", () => {
    expect(isAuthenticProxyPayRequest(KEY, body, {})).toBe(false);
  });

  it("aceita a X-Signature certa e recusa a errada ou de outro corpo", () => {
    expect(isAuthenticProxyPayRequest(KEY, body, { "x-signature": sign(body) })).toBe(true);
    expect(isAuthenticProxyPayRequest(KEY, body, { "x-signature": sign(body, "outra") })).toBe(false);
    expect(isAuthenticProxyPayRequest(KEY, body.replace("1000.00", "9999.00"), { "x-signature": sign(body) })).toBe(false);
  });

  it("aceita Basic auth só com a chave certa", () => {
    expect(isAuthenticProxyPayRequest(KEY, body, { authorization: basic(KEY) })).toBe(true);
    expect(isAuthenticProxyPayRequest(KEY, body, { authorization: basic("outra") })).toBe(false);
    expect(isAuthenticProxyPayRequest(KEY, body, { authorization: "Basic " })).toBe(false);
  });
});
