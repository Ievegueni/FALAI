import { describe, it, expect } from "vitest";
import { sanitizePermissions, applyProfile, levelAllows } from "./accessProfiles.js";
import { DEFAULT_FEATURES } from "./features.js";

describe("sanitizePermissions", () => {
  it("chaves em falta e valores inválidos ficam none", () => {
    const p = sanitizePermissions({ contacts: "write", wallet: "read", team: "admin", bogus: "write" });
    expect(p.contacts).toBe("write");
    expect(p.wallet).toBe("read");
    expect(p.team).toBe("none");
    expect(p.agents).toBe("none");
    expect("bogus" in p).toBe(false);
  });

  it("aceita lixo sem rebentar", () => {
    expect(sanitizePermissions(null).calls).toBe("none");
    expect(sanitizePermissions("x").calls).toBe("none");
  });
});

describe("applyProfile", () => {
  it("sem perfil não mexe nas features", () => {
    expect(applyProfile(DEFAULT_FEATURES, null)).toEqual(DEFAULT_FEATURES);
  });

  it("none esconde o módulo, read mantém-no visível", () => {
    const perms = sanitizePermissions({ contacts: "read", calls: "write" });
    const f = applyProfile(DEFAULT_FEATURES, perms);
    expect(f.contacts).toBe(true);
    expect(f.calls).toBe(true);
    expect(f.wallet).toBe(false);
  });

  it("nunca liga o que o tenant não tem", () => {
    const perms = sanitizePermissions({ inbox: "write" });
    expect(applyProfile({ ...DEFAULT_FEATURES, inbox: false }, perms).inbox).toBe(false);
  });
});

describe("levelAllows", () => {
  it("read só deixa passar leituras", () => {
    expect(levelAllows("read", "GET")).toBe(true);
    expect(levelAllows("read", "HEAD")).toBe(true);
    expect(levelAllows("read", "POST")).toBe(false);
    expect(levelAllows("read", "DELETE")).toBe(false);
  });

  it("write deixa tudo, none nada", () => {
    expect(levelAllows("write", "PATCH")).toBe(true);
    expect(levelAllows("none", "GET")).toBe(false);
  });
});
