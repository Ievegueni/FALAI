import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const { classifyLegCause, mergeOutcomes } = await import("./callLegs.service.js");

/**
 * Classificação das pernas. É o que separa "recusada pelo agente" de "ninguém
 * atendeu" nos relatórios — se se partir, as recusas somem-se nas perdidas.
 */
describe("classifyLegCause", () => {
  it("603 Decline (causa 21) é recusa", () => {
    expect(classifyLegCause(21, false)).toBe("REJECTED");
  });
  it("486 (causa 17) é ocupado, não recusa", () => {
    expect(classifyLegCause(17, false)).toBe("BUSY");
  });
  it("timeout e 480 contam como não atendida", () => {
    expect(classifyLegCause(19, false)).toBe("NO_ANSWER");
    expect(classifyLegCause(18, false)).toBe("NO_ANSWER");
  });
  it("causa desconhecida/offline é falha", () => {
    expect(classifyLegCause(20, false)).toBe("FAILED");
    expect(classifyLegCause(null, false)).toBe("FAILED");
  });
  it("depois de quem ligou desligar (ou outro atender), tudo é cancelado — mesmo um 603", () => {
    expect(classifyLegCause(21, true)).toBe("CANCELLED");
    expect(classifyLegCause(19, true)).toBe("CANCELLED");
  });
});

describe("mergeOutcomes (hardphone + webphone da mesma extensão)", () => {
  it("webphone offline + hardphone a tocar até ao fim → não atendida", () => {
    expect(mergeOutcomes(["FAILED", "NO_ANSWER"])).toBe("NO_ANSWER");
  });
  it("uma recusa vence um timeout", () => {
    expect(mergeOutcomes(["NO_ANSWER", "REJECTED"])).toBe("REJECTED");
  });
  it("sem canais conta como falha", () => {
    expect(mergeOutcomes([])).toBe("FAILED");
  });
});
