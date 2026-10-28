import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { agentAssignmentAllowed, canEditTicket, callScopeWhere, conversationScopeWhere, isConfigAdmin, isOpsManager, ticketScopeWhere } = await import("./userScope.js");

/** Papéis: quem vê e altera o quê (centro de atendimento, fase 2). */

const agent = { kind: "SELF" as const, userId: "u_ana", groupIds: ["g_sup"], extensionIds: ["e_1001"], extensionNumbers: ["1001"], userIds: ["u_ana"] };
const sup = { kind: "TEAM" as const, userId: "u_sup", groupIds: ["g_sup"], extensionIds: ["e_1001", "e_1002"], extensionNumbers: ["1001", "1002"], userIds: ["u_sup", "u_ana", "u_rui"] };
const all = { kind: "ALL" as const };
const tk = (assigneeId: string | null, groupId: string | null = null, createdById: string | null = null) => ({ assigneeId, groupId, createdById });

describe("papéis", () => {
  it("configuração técnica só OWNER/ADMIN; operação também o gestor", () => {
    expect(["OWNER", "ADMIN", "MANAGER", "SUPERVISOR"].map(isConfigAdmin)).toEqual([true, true, false, false]);
    expect(["OWNER", "ADMIN", "MANAGER", "SUPERVISOR", "MEMBER"].map(isOpsManager)).toEqual([true, true, true, false, false]);
  });
});

describe("tickets", () => {
  it("quem vê tudo não tem filtro", () => {
    expect(ticketScopeWhere(all)).toEqual({});
  });

  it("agente vê os seus, os que criou e a fila dele (sem dono, do grupo dele ou sem grupo)", () => {
    expect(ticketScopeWhere(agent)).toEqual({
      OR: [
        { assigneeId: "u_ana" },
        { createdById: "u_ana" },
        { assigneeId: null, groupId: null },
        { assigneeId: null, groupId: { in: ["g_sup"] } },
      ],
    });
  });

  it("agente só altera os que estão atribuídos a si", () => {
    expect(canEditTicket(agent, tk("u_ana"))).toBe(true);
    expect(canEditTicket(agent, tk(null, "g_sup"))).toBe(false); // por atribuir: tem de pegar primeiro
    expect(canEditTicket(agent, tk("u_rui", null, "u_ana"))).toBe(false); // criou mas já é de outro
  });

  it("agente pega num ticket da fila e devolve o seu à fila, mas não o passa a um colega", () => {
    expect(agentAssignmentAllowed(agent, tk(null), "u_ana")).toBe(true);
    expect(agentAssignmentAllowed(agent, tk(null), "u_rui")).toBe(false);
    expect(agentAssignmentAllowed(agent, tk("u_ana"), null)).toBe(true);
    expect(agentAssignmentAllowed(agent, tk("u_ana"), "u_rui")).toBe(false);
    expect(agentAssignmentAllowed(agent, tk("u_ana"), undefined)).toBe(true); // não mexe na atribuição
  });

  it("supervisor altera os do seu grupo, da sua equipa e os sem dono nem grupo", () => {
    expect(canEditTicket(sup, tk(null, "g_sup"))).toBe(true);
    expect(canEditTicket(sup, tk("u_rui", "g_outro"))).toBe(true);
    expect(canEditTicket(sup, tk(null))).toBe(true);
    expect(canEditTicket(sup, tk("u_ext", "g_outro"))).toBe(false);
    expect(agentAssignmentAllowed(sup, tk("u_ana"), "u_rui")).toBe(true); // supervisor atribui a quem quiser
  });
});

describe("conversas e chamadas", () => {
  it("agente: conversas suas e da fila; supervisor e gestor sem filtro", () => {
    expect(conversationScopeWhere(agent)).toEqual({ OR: [{ assigneeId: "u_ana" }, { assigneeId: null }] });
    expect(conversationScopeWhere(sup)).toEqual({});
    expect(conversationScopeWhere(all)).toEqual({});
  });

  it("chamadas: as que tocaram nas extensões do âmbito e as directas delas; o supervisor também as dos grupos", () => {
    expect(callScopeWhere(agent)).toEqual({
      OR: [{ legs: { some: { extensionId: { in: ["e_1001"] } } } }, { kind: "DIRECT", fromNumber: { in: ["1001"] } }],
    });
    expect((callScopeWhere(sup) as { OR: unknown[] }).OR).toContainEqual({ groupId: { in: ["g_sup"] } });
  });
});
