import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const { parseRetryPolicy } = await import("./callSettlement.service.js");

describe("parseRetryPolicy", () => {
  it("formato da API: usa retryDelayMinutes e tenta de novo não atendidas/ocupadas/falhadas", () => {
    expect(parseRetryPolicy({ maxAttempts: 6, retryDelayMinutes: 90 })).toEqual({
      maxAttempts: 6,
      retryOn: ["NO_ANSWER", "BUSY", "FAILED"],
      delayMinutes: 90,
    });
  });

  it("formato antigo com retryOn e delayMinutes continua a valer", () => {
    expect(parseRetryPolicy({ maxAttempts: 2, retryOn: ["BUSY"], delayMinutes: 5 })).toEqual({
      maxAttempts: 2,
      retryOn: ["BUSY"],
      delayMinutes: 5,
    });
  });

  it("sem política ou sem maxAttempts não há novas tentativas", () => {
    expect(parseRetryPolicy(null)).toBeNull();
    expect(parseRetryPolicy({ retryDelayMinutes: 10 })).toBeNull();
  });

  it("sem atraso definido usa 60 minutos", () => {
    expect(parseRetryPolicy({ maxAttempts: 3 })?.delayMinutes).toBe(60);
  });
});
