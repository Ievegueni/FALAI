import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { config } = await import("../config.js");
const { subdomainError, subdomainFromHost, isOnBaseDomain, crmUrlFor } = await import("./tenantHost.js");

/** Endereço próprio do cliente (credito.falai.ao): o que conta como cliente e o que não. */

beforeEach(() => { config.TENANT_BASE_DOMAIN = "falai.ao"; });
afterEach(() => { delete config.TENANT_BASE_DOMAIN; delete process.env["PUBLIC_CRM_URL"]; });

describe("subdomainFromHost", () => {
  it("lê o cliente de um nível abaixo do domínio base, ignorando maiúsculas e porta", () => {
    expect(subdomainFromHost("credito.falai.ao")).toBe("credito");
    expect(subdomainFromHost("Credito.FALAI.ao:443")).toBe("credito");
  });

  it("domínios gerais e reservados não são cliente", () => {
    for (const h of ["falai.ao", "admin.falai.ao", "api.falai.ao", "www.falai.ao", "falai.comunica.ao", "credito.falai.comunica.ao", "a.b.falai.ao", "xfalai.ao", undefined]) {
      expect(subdomainFromHost(h)).toBeNull();
    }
  });

  it("sem TENANT_BASE_DOMAIN a funcionalidade fica desligada", () => {
    delete config.TENANT_BASE_DOMAIN;
    expect(subdomainFromHost("credito.falai.ao")).toBeNull();
    expect(isOnBaseDomain("credito.falai.ao")).toBe(false);
  });
});

describe("isOnBaseDomain", () => {
  it("raiz, gerais e clientes do domínio novo sim; domínio antigo não", () => {
    expect(isOnBaseDomain("falai.ao")).toBe(true);
    expect(isOnBaseDomain("admin.falai.ao")).toBe(true);
    expect(isOnBaseDomain("credito.falai.ao")).toBe(true);
    expect(isOnBaseDomain("falai.comunica.ao")).toBe(false);
    expect(isOnBaseDomain("evilfalai.ao")).toBe(false);
  });
});

describe("subdomainError", () => {
  it("aceita nomes simples", () => {
    for (const s of ["credito", "a", "angovoip-2", "x1"]) expect(subdomainError(s)).toBeNull();
  });
  it("recusa formato inválido e nomes reservados", () => {
    for (const s of ["", "Credito", "-a", "a-", "a_b", "a.b", "é", "a".repeat(33)]) expect(subdomainError(s)).not.toBeNull();
    expect(subdomainError("admin")).toMatch(/reservado/);
    expect(subdomainError("api")).toMatch(/reservado/);
  });
});

describe("crmUrlFor", () => {
  it("cliente com subdomínio: o seu endereço; sem: o geral", () => {
    process.env["PUBLIC_CRM_URL"] = "https://falai.comunica.ao/";
    expect(crmUrlFor("credito")).toBe("https://credito.falai.ao");
    expect(crmUrlFor(null)).toBe("https://falai.comunica.ao");
  });
});
