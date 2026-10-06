import { describe, it, expect } from "vitest";
import { effectivePrice, computeCallCost, computeReservation } from "./billing.service.js";

const plan = { billingMode: "PER_MINUTE" as const, pricePerMinuteCents: 5000, pricePerCallCents: 3000 };

describe("effectivePrice", () => {
  it("sem excepções usa o plano", () => {
    expect(effectivePrice({ billingModeOverride: null, pricePerMinuteOverrideCents: null, plan }))
      .toEqual({ billingMode: "PER_MINUTE", pricePerMinuteCents: 5000, pricePerCallCents: 3000 });
  });

  it("o preço por minuto do cliente substitui o do plano", () => {
    const p = effectivePrice({ billingModeOverride: null, pricePerMinuteOverrideCents: 3500, plan });
    expect(p.pricePerMinuteCents).toBe(3500);
    expect(computeCallCost(61, p)).toBe(7000); // 2 minutos a 35 Kz
    expect(computeReservation(300, p)).toBe(17500);
  });

  it("vale também ao segundo, com o modo do cliente", () => {
    const p = effectivePrice({ billingModeOverride: "PER_SECOND", pricePerMinuteOverrideCents: 6000, plan });
    expect(p.billingMode).toBe("PER_SECOND");
    expect(computeCallCost(30, p)).toBe(3000);
  });

  it("0 é um preço válido (chamadas grátis), não cai para o plano", () => {
    const p = effectivePrice({ billingModeOverride: null, pricePerMinuteOverrideCents: 0, plan });
    expect(p.pricePerMinuteCents).toBe(0);
    expect(computeCallCost(120, p)).toBe(0);
  });

  it("não mexe no preço por chamada", () => {
    const p = effectivePrice({ billingModeOverride: "PER_CALL", pricePerMinuteOverrideCents: 3500, plan });
    expect(computeCallCost(90, p)).toBe(3000);
  });
});
