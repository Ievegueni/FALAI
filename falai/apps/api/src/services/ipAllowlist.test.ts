import { describe, it, expect } from "vitest";
import { normalizeIp, isValidCidr, ipMatchesAllowlist } from "./ipAllowlist.js";

describe("normalizeIp", () => {
  it("desembrulha IPv4 dentro de IPv6", () => {
    expect(normalizeIp("::ffff:102.130.202.155")).toBe("102.130.202.155");
  });

  it("descarta a zona de interface", () => {
    expect(normalizeIp("fe80::1%en0")).toBe("fe80::1");
  });

  it("recusa lixo", () => {
    expect(normalizeIp("nao-e-um-ip")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("")).toBeNull();
  });
});

describe("isValidCidr", () => {
  it("aceita IPs soltos e CIDR", () => {
    expect(isValidCidr("102.130.202.155")).toBe(true);
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("2001:db8::/32")).toBe(true);
    expect(isValidCidr("0.0.0.0/0")).toBe(true);
  });

  it("recusa prefixos impossíveis e lixo", () => {
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("2001:db8::/129")).toBe(false);
    expect(isValidCidr("10.0.0.0/abc")).toBe(false);
    expect(isValidCidr("")).toBe(false);
  });
});

describe("ipMatchesAllowlist", () => {
  it("lista vazia não restringe nada", () => {
    expect(ipMatchesAllowlist("8.8.8.8", [])).toBe(true);
  });

  it("casa IP exacto", () => {
    expect(ipMatchesAllowlist("102.130.202.155", ["102.130.202.155"])).toBe(true);
    expect(ipMatchesAllowlist("102.130.202.156", ["102.130.202.155"])).toBe(false);
  });

  it("casa dentro do bloco e falha fora", () => {
    expect(ipMatchesAllowlist("10.3.4.5", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesAllowlist("11.3.4.5", ["10.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("192.168.1.7", ["192.168.1.0/24"])).toBe(true);
    expect(ipMatchesAllowlist("192.168.2.7", ["192.168.1.0/24"])).toBe(false);
  });

  it("ignora bits de host na entrada da lista", () => {
    expect(ipMatchesAllowlist("10.9.9.9", ["10.1.2.3/8"])).toBe(true);
  });

  it("casa IPv4 mesmo quando chega embrulhado em IPv6", () => {
    expect(ipMatchesAllowlist("::ffff:10.3.4.5", ["10.0.0.0/8"])).toBe(true);
  });

  it("não mistura famílias", () => {
    expect(ipMatchesAllowlist("10.0.0.1", ["2001:db8::/32"])).toBe(false);
    expect(ipMatchesAllowlist("2001:db8::1", ["10.0.0.0/8"])).toBe(false);
  });

  it("casa IPv6", () => {
    expect(ipMatchesAllowlist("2001:db8:1234::1", ["2001:db8::/32"])).toBe(true);
    expect(ipMatchesAllowlist("2001:dba::1", ["2001:db8::/32"])).toBe(false);
  });

  it("uma entrada inválida não abre a porta às outras", () => {
    expect(ipMatchesAllowlist("8.8.8.8", ["lixo", "10.0.0.0/8"])).toBe(false);
    expect(ipMatchesAllowlist("10.0.0.1", ["lixo", "10.0.0.0/8"])).toBe(true);
  });

  it("recusa quando o IP de origem é desconhecido", () => {
    expect(ipMatchesAllowlist(undefined, ["10.0.0.0/8"])).toBe(false);
  });
});
