import { describe, it, expect } from "vitest";
import {
  normalizeLineGroup,
  parseLineGroupLimits,
  resolveLineGroup,
  lineGroupCallFilter,
  validateCampaignLineGroup,
} from "./lineGroups.js";

const tenant = { lineGroupLimits: { COBRANCA: 6, MARKETING: 6 }, defaultLineGroup: "COBRANCA" };

describe("normalizeLineGroup", () => {
  it("tira acentos, espaços e passa a maiúsculas", () => {
    expect(normalizeLineGroup(" Cobrança ")).toBe("COBRANCA");
    expect(normalizeLineGroup("pós venda")).toBe("POS_VENDA");
  });
  it("recusa nomes inválidos", () => {
    expect(normalizeLineGroup("")).toBeNull();
    expect(normalizeLineGroup("a/b")).toBeNull();
    expect(normalizeLineGroup("X".repeat(33))).toBeNull();
    expect(normalizeLineGroup(5)).toBeNull();
  });
});

describe("parseLineGroupLimits", () => {
  it("ignora entradas inválidas", () => {
    expect(parseLineGroupLimits({ cobranca: 6, MARKETING: 0, X: 2.5, Y: "3", Z: 51, OK: 50 })).toEqual({ COBRANCA: 6, OK: 50 });
    expect(parseLineGroupLimits(null)).toEqual({});
    expect(parseLineGroupLimits([1, 2])).toEqual({});
  });
});

describe("resolveLineGroup", () => {
  it("cliente sem grupos: só o limite total", () => {
    expect(resolveLineGroup("MARKETING", { lineGroupLimits: null, defaultLineGroup: null })).toBeNull();
  });
  it("campanha com grupo", () => {
    expect(resolveLineGroup("MARKETING", tenant)).toEqual({ group: "MARKETING", limit: 6, isDefault: false });
  });
  it("campanha sem grupo cai no grupo por omissão", () => {
    expect(resolveLineGroup(null, tenant)).toEqual({ group: "COBRANCA", limit: 6, isDefault: true });
  });
  it("sem grupo e sem omissão: só o limite total", () => {
    expect(resolveLineGroup(null, { ...tenant, defaultLineGroup: null })).toBeNull();
  });
  it("grupo que deixou de existir: só o limite total", () => {
    expect(resolveLineGroup("ANTIGO", tenant)).toBeNull();
  });
});

describe("lineGroupCallFilter", () => {
  it("o grupo por omissão inclui as campanhas sem grupo", () => {
    expect(lineGroupCallFilter({ group: "COBRANCA", isDefault: true })).toEqual({
      campaign: { OR: [{ lineGroup: "COBRANCA" }, { lineGroup: null }] },
    });
    expect(lineGroupCallFilter({ group: "MARKETING", isDefault: false })).toEqual({ campaign: { lineGroup: "MARKETING" } });
  });
});

describe("validateCampaignLineGroup", () => {
  it("undefined não mexe; null e vazio limpam", () => {
    expect(validateCampaignLineGroup(undefined, tenant)).toEqual({ ok: true, value: undefined });
    expect(validateCampaignLineGroup(null, tenant)).toEqual({ ok: true, value: null });
    expect(validateCampaignLineGroup("", tenant)).toEqual({ ok: true, value: null });
  });
  it("aceita grupos do cliente, normalizados", () => {
    expect(validateCampaignLineGroup("marketing", tenant)).toEqual({ ok: true, value: "MARKETING" });
  });
  it("recusa grupos que o cliente não tem e diz quais existem", () => {
    const r = validateCampaignLineGroup("VENDAS", tenant);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.allowed).toEqual(["COBRANCA", "MARKETING"]);
  });
  it("cliente sem grupos aceita qualquer nome válido", () => {
    expect(validateCampaignLineGroup("VENDAS", { lineGroupLimits: null, defaultLineGroup: null })).toEqual({ ok: true, value: "VENDAS" });
  });
});
