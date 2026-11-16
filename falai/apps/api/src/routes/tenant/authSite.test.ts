import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

// Utilizadores ADMIN: o OWNER passou a ter 2FA obrigatória (segurança do login)
// e este teste é só sobre o endereço.
/**
 * Endereço próprio do cliente (credito.falai.ao): o login fica preso a esse
 * cliente, e o ecrã de login sabe de quem é o endereço. Pelos domínios gerais
 * (os antigos) tudo continua como antes.
 */

const users: Record<string, { id: string; email: string; tenantId: string; passwordHash: string; twoFaSecret: string | null; role: string; name: string; accessProfile: null; tenant: { id: string; status: string; deletedAt: null; subdomain: string | null } }> = {
  "ana@credito.ao": { id: "u1", email: "ana@credito.ao", tenantId: "t_cred", passwordHash: "ok", twoFaSecret: null, role: "ADMIN", name: "Ana", accessProfile: null, tenant: { id: "t_cred", status: "ACTIVE", deletedAt: null, subdomain: "credito" } },
  "rui@solluar.ao": { id: "u2", email: "rui@solluar.ao", tenantId: "t_sol", passwordHash: "ok", twoFaSecret: null, role: "ADMIN", name: "Rui", accessProfile: null, tenant: { id: "t_sol", status: "ACTIVE", deletedAt: null, subdomain: null } },
};
const tenants: Record<string, { name: string; logoDataUrl: string | null; subdomain: string | null }> = {
  t_cred: { name: "FACIL CREDITO", logoDataUrl: null, subdomain: "credito" },
  t_sol: { name: "SOLLUAR", logoDataUrl: null, subdomain: null },
};
const prisma = {
  tenantUser: {
    findUnique: vi.fn(async ({ where }: any) => users[where.email] ?? null),
    update: vi.fn(async () => ({})),
  },
  tenant: {
    findUnique: vi.fn(async ({ where }: any) => ({ id: where.id, ...tenants[where.id], status: "ACTIVE", balanceCents: 0, features: {}, plan: null })),
    findFirst: vi.fn(async ({ where }: any) => Object.values(tenants).find((t) => t.subdomain === where.subdomain) ?? null),
  },
};
vi.mock("@falai/db", () => ({ prisma }));
vi.mock("../../services/auth.service.js", () => ({
  hashPassword: vi.fn(),
  verifyPasswordOrDummy: vi.fn(async (hash: string | undefined, pw: string) => hash === "ok" && pw === "certa"),
  isLoginLocked: vi.fn(async () => false),
  recordLoginFailure: vi.fn(async () => {}),
  clearLoginFailures: vi.fn(async () => {}),
  LOCKED_MESSAGE: "bloqueada",
  tenantRoleRequires2Fa: (role: string) => role === "OWNER",
  generateTotpSecret: vi.fn(),
  generateTotpQrCode: vi.fn(),
  verifyTotp: vi.fn(),
  issueTenantToken: vi.fn(async () => "jwt"),
  pending2FaTenantKey: (s: string) => s,
}));

const { config } = await import("../../config.js");
const { tenantAuthRoutes } = await import("./auth.js");

const audit = vi.fn(async () => {});
async function app() {
  const f = Fastify();
  f.decorate("verifyTenant", async () => {});
  f.decorate("audit", audit);
  f.decorate("redis", {} as never);
  await f.register(tenantAuthRoutes, { prefix: "/tenant/auth" });
  return f;
}
const login = async (host: string, email: string, password = "certa") =>
  (await app()).inject({ method: "POST", url: "/tenant/auth/login", headers: { host }, payload: { email, password } });

beforeEach(() => { config.TENANT_BASE_DOMAIN = "falai.ao"; vi.clearAllMocks(); });
afterEach(() => { delete config.TENANT_BASE_DOMAIN; });

describe("login no endereço próprio do cliente", () => {
  it("o utilizador do cliente entra", async () => {
    const res = await login("credito.falai.ao", "ana@credito.ao");
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe("jwt");
    expect(res.json().tenant.crmUrl).toBe("https://credito.falai.ao");
  });

  it("utilizador de outro cliente, com a password certa: recusado e encaminhado para o seu endereço", async () => {
    const res = await login("credito.falai.ao", "rui@solluar.ao");
    expect(res.statusCode).toBe(403);
    expect(res.json().token).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.login.wrong_site" }));
  });

  it("utilizador de outro cliente com a password errada: o mesmo 401 de sempre (não revela que a conta existe)", async () => {
    const res = await login("credito.falai.ao", "rui@solluar.ao", "errada");
    expect(res.statusCode).toBe(401);
    expect(res.json().crmUrl).toBeUndefined();
  });

  it("subdomínio que não é de ninguém não deixa entrar", async () => {
    expect((await login("outro.falai.ao", "ana@credito.ao")).statusCode).toBe(403);
  });
});

describe("login pelos domínios gerais (como antes)", () => {
  it("qualquer cliente entra pelo domínio antigo e pelo admin/api do novo", async () => {
    expect((await login("falai.comunica.ao", "ana@credito.ao")).statusCode).toBe(200);
    expect((await login("falai.comunica.ao", "rui@solluar.ao")).statusCode).toBe(200);
  });

  it("sem TENANT_BASE_DOMAIN não há restrição nenhuma", async () => {
    delete config.TENANT_BASE_DOMAIN;
    expect((await login("credito.falai.ao", "rui@solluar.ao")).statusCode).toBe(200);
  });
});

describe("GET /tenant/auth/site", () => {
  const site = async (host: string) => (await app()).inject({ method: "GET", url: "/tenant/auth/site", headers: { host } });

  it("endereço de cliente: devolve o nome", async () => {
    const res = await site("credito.falai.ao");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subdomain: "credito", tenantName: "FACIL CREDITO" });
  });

  it("endereço desconhecido: 404", async () => {
    expect((await site("outro.falai.ao")).statusCode).toBe(404);
  });

  it("domínio geral: sem cliente", async () => {
    expect((await site("falai.comunica.ao")).json()).toEqual({ subdomain: null });
  });
});
