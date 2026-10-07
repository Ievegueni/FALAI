import { describe, it, expect } from "vitest";
import { planTicketUpdate, TicketError, type TicketState } from "./tickets.service.js";

/** Regras de estado dos tickets: reabertura, fecho final, eventos from → to. */

const base: TicketState & { reopenCount: number } = {
  status: "OPEN", priority: "MEDIUM", supportLevel: 1, assigneeId: null, groupId: null,
  categoryId: null, subcategoryId: null, subject: "Sem rede", description: null, dueAt: null, reopenCount: 0,
};
const now = new Date("2026-10-06T10:00:00Z");

describe("planTicketUpdate", () => {
  it("resolver marca resolvedAt e gera evento STATUS", () => {
    const r = planTicketUpdate(base, { status: "RESOLVED" }, now);
    expect(r.data).toMatchObject({ status: "RESOLVED", resolvedAt: now });
    expect(r.events).toEqual([{ type: "STATUS", fromValue: "OPEN", toValue: "RESOLVED" }]);
    expect(r.reopened).toBe(false);
  });

  it("sair de RESOLVED é reabrir: conta e limpa resolvedAt", () => {
    const r = planTicketUpdate({ ...base, status: "RESOLVED", reopenCount: 2 }, { status: "OPEN" }, now);
    expect(r.reopened).toBe(true);
    expect(r.data).toMatchObject({ status: "OPEN", resolvedAt: null, reopenCount: 3 });
  });

  it("RESOLVED → CLOSED fecha sem contar como reabertura", () => {
    const r = planTicketUpdate({ ...base, status: "RESOLVED" }, { status: "CLOSED" }, now);
    expect(r.reopened).toBe(false);
    expect(r.data).toMatchObject({ status: "CLOSED", closedAt: now });
    expect(r.data).not.toHaveProperty("resolvedAt");
  });

  it("fechar directamente também marca resolvedAt", () => {
    expect(planTicketUpdate(base, { status: "CLOSED" }, now).data).toMatchObject({ resolvedAt: now, closedAt: now });
  });

  it("CLOSED é final", () => {
    expect(() => planTicketUpdate({ ...base, status: "CLOSED" }, { status: "OPEN" })).toThrow(TicketError);
  });

  it("escalar nível e atribuir geram um evento cada; valor igual não gera nada", () => {
    const r = planTicketUpdate(base, { supportLevel: 2, assigneeId: "u1", priority: "MEDIUM" }, now);
    expect(r.events.map((e) => e.type)).toEqual(["LEVEL", "ASSIGNEE"]);
    expect(r.events[0]).toMatchObject({ fromValue: "1", toValue: "2" });
  });

  it("nível fora de 1–3 é recusado", () => {
    expect(() => planTicketUpdate(base, { supportLevel: 4 })).toThrow(TicketError);
  });

  it("categoria + subcategoria num só evento", () => {
    const r = planTicketUpdate(base, { categoryId: "c1", subcategoryId: "s1" }, now);
    expect(r.events).toEqual([{ type: "CATEGORY", fromValue: "/", toValue: "c1/s1" }]);
    expect(r.data).toMatchObject({ categoryId: "c1", subcategoryId: "s1" });
  });

  it("descrição muda sem evento na linha do tempo", () => {
    const r = planTicketUpdate(base, { description: "mais detalhe" }, now);
    expect(r.events).toEqual([]);
    expect(r.data).toEqual({ description: "mais detalhe" });
  });
});
