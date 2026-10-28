import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { scoreEvaluation, normalizeDefinition, cleanAnswers, QaError } = await import("./quality.service.js");

/** QA score: pesos, não aplicáveis e critérios eliminatórios. */

const def = normalizeDefinition({
  sections: [
    { title: "Abertura", criteria: [{ id: "saud", label: "Saudação", weight: 1 }, { id: "ident", label: "Identificou o cliente", weight: 2, critical: true }] },
    { title: "Resolução", criteria: [{ id: "res", label: "Resolveu", weight: 3 }, { id: "fecho", label: "Fecho", weight: 1 }] },
  ],
});

describe("formulário", () => {
  it("mantém os ids existentes e dá id aos novos, sem repetir", () => {
    const d = normalizeDefinition({ sections: [{ title: "S", criteria: [{ id: "a", label: "A" }, { label: "B" }, { id: "a", label: "C" }] }] });
    const ids = d.sections[0]!.criteria.map((c) => c.id);
    expect(ids[0]).toBe("a");
    expect(new Set(ids).size).toBe(3);
    expect(d.sections[0]!.criteria[1]).toMatchObject({ weight: 1, critical: false });
  });

  it("formulário vazio é recusado", () => {
    expect(() => normalizeDefinition({ sections: [] })).toThrow();
  });
});

describe("score", () => {
  it("peso dos conformes sobre o peso avaliado", () => {
    expect(scoreEvaluation(def, { saud: "YES", ident: "YES", res: "NO", fecho: "YES" })).toEqual({ score: 57.1, criticalFail: false }); // 4/7
  });

  it("não aplicável sai das contas", () => {
    expect(scoreEvaluation(def, { saud: "YES", ident: "YES", res: "NA", fecho: "NO" }).score).toBe(75); // 3/4
  });

  it("eliminatório em não conforme dá 0", () => {
    expect(scoreEvaluation(def, { saud: "YES", ident: "NO", res: "YES", fecho: "YES" })).toEqual({ score: 0, criticalFail: true });
  });

  it("tudo não aplicável dá 100", () => {
    expect(scoreEvaluation(def, { saud: "NA", ident: "NA", res: "NA", fecho: "NA" }).score).toBe(100);
  });

  it("falta de respostas é erro e diz quais", () => {
    expect(() => scoreEvaluation(def, { saud: "YES" })).toThrow(QaError);
    expect(() => scoreEvaluation(def, { saud: "YES" })).toThrow(/Identificou o cliente/);
  });

  it("respostas de critérios que não existem são descartadas", () => {
    expect(cleanAnswers(def, { saud: "YES", ident: "NO", res: "YES", fecho: "NA", lixo: "YES" })).toEqual({ saud: "YES", ident: "NO", res: "YES", fecho: "NA" });
  });
});
