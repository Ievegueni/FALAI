import { describe, it, expect } from "vitest";
import { callsWhere, searchWhere, callsFilterSchema } from "./callsFilter.service.js";

/** Filtros da página Chamadas: sempre isolados por tenant. */
describe("filtros da lista de chamadas", () => {
  it("sem filtros = só o tenant", () => {
    expect(callsWhere("t1", {})).toEqual({ tenantId: "t1" });
  });
  it("período em dias locais, direcção e o tipo explícito a ganhar à direcção", () => {
    const w = callsWhere("t1", { from: "2026-10-01", to: "2026-10-02", direction: "outbound", kind: "OTP" });
    expect(w.createdAt).toEqual({ gte: new Date("2026-10-01T00:00:00"), lte: new Date("2026-10-02T23:59:59.999") });
    expect(w.kind).toBe("OTP");
  });
  it("quem atendeu e a tipificação passam pelas pernas", () => {
    const w = callsWhere("t1", { extensionId: "e1", categoryId: "c1" });
    expect(w.AND).toEqual([
      { legs: { some: { extensionId: "e1", outcome: "ANSWERED" } } },
      { legs: { some: { OR: [{ categoryId: "c1" }, { subcategoryId: "c1" }] } } },
    ]);
  });
  it("pesquisa: número pelos últimos 9 dígitos (+244 ou não) e nome do contacto", () => {
    const w = searchWhere("+244 923 456 789");
    expect(w.OR).toEqual([
      { contact: { name: { contains: "+244 923 456 789", mode: "insensitive" } } },
      { fromNumber: { contains: "923456789" } },
      { toNumber: { contains: "923456789" } },
    ]);
    expect(searchWhere("Maria").OR).toHaveLength(1); // só nome
  });
  it("estado inválido é recusado", () => {
    expect(() => callsFilterSchema.parse({ status: "DROP TABLE" })).toThrow();
  });
});
