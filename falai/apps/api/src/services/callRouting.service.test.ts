import { describe, it, expect, vi, beforeEach } from "vitest";

const inboundFindMany = vi.fn();
const trunkFindUnique = vi.fn();
vi.mock("@falai/db", () => ({
  prisma: {
    inboundRoute: { findMany: inboundFindMany },
    trunk: { findUnique: trunkFindUnique },
  },
}));

const { normalizeDid, isFullDid, resolveInboundGlobal, sharedTrunkDidProblem } = await import("./callRouting.service.js");

const route = (tenantId: string, didPattern: string) => ({ tenantId, didPattern, destType: "EXTENSION", destValue: "201" });

beforeEach(() => {
  inboundFindMany.mockReset();
  trunkFindUnique.mockReset();
});

describe("normalizeDid / isFullDid", () => {
  it("o mesmo número em formatos diferentes fica igual", () => {
    expect(normalizeDid("923 456 789")).toBe("923456789");
    expect(normalizeDid("+244923456789")).toBe("923456789");
    expect(normalizeDid("00244923456789")).toBe("923456789");
  });
  it("prefixos não são números completos", () => {
    expect(isFullDid("9")).toBe(false);
    expect(isFullDid("92345")).toBe(false);
    expect(isFullDid("+244923456789")).toBe(true);
  });
});

describe("resolveInboundGlobal", () => {
  it("só procura rotas de trunks partilhados", async () => {
    inboundFindMany.mockResolvedValue([]);
    await resolveInboundGlobal("923456789");
    expect(inboundFindMany.mock.calls[0]![0].where).toEqual({ trunk: { tenantId: null } });
  });

  it("um prefixo de outro cliente não apanha a chamada", async () => {
    inboundFindMany.mockResolvedValue([route("intruso", "9")]);
    expect(await resolveInboundGlobal("923456789")).toBeNull();
  });

  it("entrega pelo número exacto, em qualquer formato", async () => {
    inboundFindMany.mockResolvedValue([route("dono", "+244923456789")]);
    expect((await resolveInboundGlobal("923456789"))?.tenantId).toBe("dono");
  });

  it("número em dois clientes: não entrega a nenhum", async () => {
    inboundFindMany.mockResolvedValue([route("a", "923456789"), route("b", "244923456789")]);
    expect(await resolveInboundGlobal("923456789")).toBeNull();
  });
});

describe("sharedTrunkDidProblem", () => {
  it("trunk próprio do cliente: a numeração é dele, não se valida", async () => {
    trunkFindUnique.mockResolvedValue({ tenantId: "t1" });
    expect(await sharedTrunkDidProblem("t1", "trk", "1")).toBeNull();
  });

  it("trunk partilhado: recusa prefixos e números de outro cliente", async () => {
    trunkFindUnique.mockResolvedValue({ tenantId: null });
    expect(await sharedTrunkDidProblem("t1", "trk", "9")).toMatch(/número completo/);

    inboundFindMany.mockResolvedValue([{ didPattern: "+244923456789" }]);
    expect(await sharedTrunkDidProblem("t1", "trk", "923456789")).toMatch(/outro cliente/);
    expect(inboundFindMany.mock.calls[0]![0].where.tenantId).toEqual({ not: "t1" });

    inboundFindMany.mockResolvedValue([]);
    expect(await sharedTrunkDidProblem("t1", "trk", "923456789")).toBeNull();
  });
});
