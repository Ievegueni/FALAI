import { describe, it, expect } from "vitest";
import { computeFeatures } from "./features.js";

describe("computeFeatures", () => {
  it("funcionalidades novas nascem desligadas; override liga", () => {
    expect(computeFeatures({}).inbox).toBe(false);
    expect(computeFeatures({ overrides: { inbox: true } }).inbox).toBe(true);
  });
  it("o plano manda: sem IA não há agentes, sem SMS não há SMS", () => {
    const f = computeFeatures({ overrides: { agents: true, sms: true }, aiAgentsEnabled: false, smsEnabled: false });
    expect([f.agents, f.campaigns, f.sms]).toEqual([false, false, false]);
  });
  it("API_BYOM: UI desligada, mas a vista da API respeita overrides", () => {
    expect(computeFeatures({ productType: "API_BYOM" }).agents).toBe(false);
    expect(computeFeatures({ productType: "API_BYOM" }).developers).toBe(true);
    expect(computeFeatures({ productType: "API_BYOM", forApi: true }).agents).toBe(true);
  });
});
