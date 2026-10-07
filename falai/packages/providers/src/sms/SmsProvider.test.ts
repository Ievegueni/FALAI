import { describe, it, expect } from "vitest";
import { countSegments } from "./SmsProvider.js";

describe("countSegments (GSM 03.38)", () => {
  it("texto GSM básico: 160 num segmento, 153 depois", () => {
    expect(countSegments("a".repeat(160))).toBe(1);
    expect(countSegments("a".repeat(161))).toBe(2);
    expect(countSegments("a".repeat(306))).toBe(2);
    expect(countSegments("a".repeat(307))).toBe(3);
  });

  it("acentos da tabela básica (é, à, Ç) continuam GSM", () => {
    expect(countSegments("é".repeat(160))).toBe(1);
    expect(countSegments("Çà".repeat(80))).toBe(1);
  });

  it("á, ã, ç, í, õ forçam UCS-2 (70/67)", () => {
    for (const ch of ["á", "ã", "ç", "í", "õ", "ê"]) {
      expect(countSegments(ch + "a".repeat(69))).toBe(1);
      expect(countSegments(ch + "a".repeat(70))).toBe(2);
    }
    expect(countSegments("Olá, a sua encomenda está pronta. " + "x".repeat(40))).toBe(2);
  });

  it("extensão conta 2 septetos", () => {
    expect(countSegments("€".repeat(80))).toBe(1);
    expect(countSegments("€".repeat(81))).toBe(2);
    expect(countSegments("[]{}~^|\\".repeat(10))).toBe(1);
    expect(countSegments("[]{}~^|\\".repeat(10) + "a")).toBe(2);
  });

  it("emoji conta 2 unidades UTF-16", () => {
    expect(countSegments("😀".repeat(35))).toBe(1);
    expect(countSegments("😀".repeat(36))).toBe(2);
  });
});
