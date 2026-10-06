import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
vi.mock("./sms.service.js", () => ({ sendSms: vi.fn() }));
const { parseScore, csatSummary, parseCsatConfig, DEFAULT_QUESTION } = await import("./csat.service.js");

/** CSAT: o que conta como resposta, e as contas. */

describe("resposta por texto", () => {
  it("aceita só um número de 1 a 5 sozinho", () => {
    expect(["5", " 4 ", "3.", "1!"].map(parseScore)).toEqual([5, 4, 3, 1]);
    expect(["0", "6", "45", "nota 5", "5 estrelas", "", "obrigado"].map(parseScore)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe("resumo", () => {
  it("média, % de satisfeitos (4–5) e distribuição", () => {
    expect(csatSummary([5, 4, 3, 1, 5])).toEqual({
      responses: 5,
      avg: 3.6,
      satisfiedPct: 60,
      distribution: { 1: 1, 2: 0, 3: 1, 4: 1, 5: 2 },
    });
  });

  it("sem respostas: nulos, não zeros", () => {
    expect(csatSummary([])).toMatchObject({ responses: 0, avg: null, satisfiedPct: null });
  });
});

describe("definições", () => {
  it("tudo desligado e pergunta por omissão quando não há nada guardado", () => {
    expect(parseCsatConfig(null)).toMatchObject({ voice: false, text: false, sms: false, question: DEFAULT_QUESTION });
  });
});
