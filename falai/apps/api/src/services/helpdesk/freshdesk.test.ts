import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { normalizeFdDomain, fdBaseUrl, toFdStatus, fromFdStatus, toFdPriority, fromFdPriority, toFdSource } = await import("./freshdesk.js");
const { fdTicketBody } = await import("./sync.js");

/** Freshdesk: domínio aceite (a API key do cliente vai para lá) e conversões. */

describe("domínio", () => {
  it("aceita *.freshdesk.com, com ou sem https e barra", () => {
    expect(normalizeFdDomain("https://Mano.freshdesk.com/", true)).toBe("mano.freshdesk.com");
    expect(normalizeFdDomain("mano-ao.freshdesk.com", true)).toBe("mano-ao.freshdesk.com");
    expect(fdBaseUrl("mano.freshdesk.com")).toBe("https://mano.freshdesk.com/api/v2");
  });

  it("recusa tudo o resto — a chave não pode ir para outro servidor", () => {
    for (const d of ["evil.com", "mano.freshdesk.com.evil.com", "freshdesk.com", "169.254.169.254", "localhost:4999"]) {
      expect(normalizeFdDomain(d, true)).toBeNull();
    }
  });

  it("localhost só fora de produção (Freshdesk falso para testes)", () => {
    expect(normalizeFdDomain("localhost:4999", false)).toBe("localhost:4999");
    expect(fdBaseUrl("localhost:4999")).toBe("http://localhost:4999/api/v2");
  });
});

describe("conversões", () => {
  it("estados: ida e volta; em espera vai como pendente; estados próprios contam como abertos", () => {
    expect(["OPEN", "PENDING", "RESOLVED", "CLOSED"].map((s) => fromFdStatus(toFdStatus(s as never)))).toEqual(["OPEN", "PENDING", "RESOLVED", "CLOSED"]);
    expect(toFdStatus("ON_HOLD")).toBe(3);
    expect([6, 7, 12].map(fromFdStatus)).toEqual(["PENDING", "ON_HOLD", "OPEN"]);
  });

  it("prioridades e origem", () => {
    expect(["LOW", "MEDIUM", "HIGH", "URGENT"].map((p) => fromFdPriority(toFdPriority(p as never)))).toEqual(["LOW", "MEDIUM", "HIGH", "URGENT"]);
    expect(["CALL", "EMAIL", "WHATSAPP", "MANUAL"].map(toFdSource)).toEqual([3, 1, 7, 2]);
  });

  it("corpo do ticket: estado, prioridade, responsável, grupo e etiquetas de nível e tipificação", () => {
    expect(
      fdTicketBody(
        { subject: "Sem rede", description: null, status: "PENDING", priority: "HIGH", categoryName: "Suporte", subcategoryName: "Internet", supportLevel: 2 },
        { responderId: 77, groupId: null }
      )
    ).toEqual({ subject: "Sem rede", status: 3, priority: 3, responder_id: 77, tags: ["nivel-2", "Suporte / Internet"] });
  });
});
