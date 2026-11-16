import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
vi.mock("./billing.service.js", () => ({}));
vi.mock("./callRecording.service.js", () => ({}));
const { normalizeFields, cleanValues, FormError, isNif, completenessKeys } = await import("./contactForms.service.js");
const { parseAiOutput, billedMinutes, transcriptMetrics } = await import("./qaAi.service.js");
const { normalizeDefinition, scoreEvaluation, qaReport } = await import("./quality.service.js");

describe("ficha de recolha", () => {
  const fields = normalizeFields([
    { label: "Data de nascimento", type: "date", required: true },
    { label: "Província", type: "select", options: ["Luanda", "Benguela"] },
    { label: "Província", type: "text" },
    { key: "nif", label: "NIF", type: "text" },
    { label: "Tem viatura", type: "yesno" },
    { label: "Filhos", type: "number" },
  ]);

  it("gera chaves a partir do rótulo, sem repetir, e mantém as dadas", () => {
    expect(fields.map((f) => f.key)).toEqual(["data_de_nascimento", "provincia", "provincia_2", "nif", "tem_viatura", "filhos"]);
  });

  it("lista sem opções é recusada", () => {
    expect(() => normalizeFields([{ label: "X", type: "select" }])).toThrow(FormError);
  });

  it("converte e valida os valores; vazio opcional = null; ignora chaves de fora", () => {
    expect(
      cleanValues(fields, { data_de_nascimento: "1990-05-01", provincia: "Luanda", tem_viatura: true, filhos: "2,5", lixo: "x" }),
    ).toEqual({ data_de_nascimento: "1990-05-01", provincia: "Luanda", provincia_2: null, nif: null, tem_viatura: true, filhos: 2.5 });
  });

  it("obrigatório em falta, opção fora da lista e número inválido falham", () => {
    expect(() => cleanValues(fields, {})).toThrow(/Data de nascimento/);
    expect(() => cleanValues(fields, { data_de_nascimento: "1990-05-01", provincia: "Huambo" })).toThrow(FormError);
    expect(() => cleanValues(fields, { data_de_nascimento: "1990-05-01", filhos: "dois" })).toThrow(FormError);
  });
});

describe("auditoria com IA", () => {
  const def = normalizeDefinition({
    sections: [{ title: "S", criteria: [{ id: "a", label: "Saudação" }, { id: "b", label: "Fecho" }] }],
  });

  it("critério que a IA esqueceu ou respondeu mal fica NA", () => {
    const r = parseAiOutput(def, { criteria: [{ id: "a", answer: "NO", reason: "Não cumprimentou", quote: "Diga" }, { id: "x", answer: "YES" }], summary: "ok" });
    expect(r.answers).toEqual({ a: "NO", b: "NA" });
    expect(r.criteria.a).toEqual({ reason: "Não cumprimentou", quote: "Diga" });
    expect(r.criteria.b!.reason).toMatch(/não avaliou/);
    expect(parseAiOutput(def, { criteria: [{ id: "a", answer: "TALVEZ" }] }).answers.a).toBe("NA");
  });

  it("minutos cobrados arredondam para cima, mínimo 1", () => {
    expect([0, 1, 60, 61, 125].map(billedMinutes)).toEqual([1, 1, 1, 2, 3]);
  });
});

describe("ficha: NIF/BI, província e campos condicionais", () => {
  const fields = normalizeFields([
    { label: "NIF", type: "nif" },
    { label: "BI", type: "bi" },
    { label: "Província", type: "province" },
    { label: "Tem empresa", type: "yesno" },
    { label: "Nome da empresa", type: "text", required: true, showIf: { key: "tem_empresa", equals: true } },
  ]);

  it("NIF aceita BI ou 10 dígitos; BI só no formato 9+2+3", () => {
    expect([isNif("004567890LA042"), isNif("5000123456"), isNif("12345")]).toEqual([true, true, false]);
    expect(cleanValues(fields, { nif: "5000 123 456", bi: "004567890la042" })).toMatchObject({ nif: "5000123456", bi: "004567890LA042" });
    expect(() => cleanValues(fields, { bi: "5000123456" })).toThrow(/BI inválido/);
    expect(() => cleanValues(fields, { provincia: "Lisboa" })).toThrow(/província/);
  });

  it("o campo condicional só se exige (e só se grava) quando a condição se cumpre", () => {
    expect(cleanValues(fields, { tem_empresa: false, nome_da_empresa: "X" })).not.toHaveProperty("nome_da_empresa");
    expect(() => cleanValues(fields, { tem_empresa: true })).toThrow(/Nome da empresa/);
    expect(cleanValues(fields, { tem_empresa: true, nome_da_empresa: "Lda" }).nome_da_empresa).toBe("Lda");
  });

  it("condição tem de apontar para um sim/não ou lista anterior", () => {
    expect(() => normalizeFields([{ label: "A", type: "text", showIf: { key: "b", equals: true } }, { label: "B", type: "yesno" }])).toThrow(FormError);
  });

  it("perfil completo conta só os campos sem condição", () => {
    expect(completenessKeys(fields)).toEqual(["nif", "bi", "provincia", "tem_empresa"]);
  });
});

describe("qualidade: escala e relatório", () => {
  const def = normalizeDefinition({
    sections: [{ title: "S", criteria: [{ id: "a", label: "Saudação", weight: 1 }, { id: "t", label: "Tom", weight: 1, type: "scale", critical: true }, { id: "f", label: "Ficha", weight: 1, type: "auto_form" }] }],
  });

  it("escala 1–5 vale 0–100 %; eliminatório não se aplica à escala", () => {
    expect(def.sections[0]!.criteria[1]!.critical).toBe(false);
    expect(scoreEvaluation(def, { a: "YES", t: "4", f: "NA" }).score).toBe(87.5);
    expect(() => scoreEvaluation(def, { a: "YES", t: "YES", f: "NA" })).toThrow(/Tom/);
  });

  it("a IA não responde aos automáticos e uma escala inválida fica NA", () => {
    const r = parseAiOutput(def, { criteria: [{ id: "a", answer: "YES" }, { id: "t", answer: "9" }, { id: "f", answer: "YES" }], divergences: [{ field: "nif", formValue: "1", said: "2" }] });
    expect(r.answers).toEqual({ a: "YES", t: "NA" });
    expect(r.divergences).toEqual([{ field: "nif", formValue: "1", said: "2", quote: "" }]);
  });

  it("relatório por critério e por semana (segunda-feira)", () => {
    const snap = { name: "G", ...def };
    const rep = qaReport([
      { createdAt: new Date("2026-11-11T10:00:00"), score: 50, answers: { a: "NO", t: "3", f: "NA" }, formSnapshot: snap },
      { createdAt: new Date("2026-11-12T10:00:00"), score: 100, answers: { a: "YES", t: "5", f: "YES" }, formSnapshot: snap },
    ]);
    expect(rep.weekly).toEqual([{ week: "2026-11-09", avgScore: 75, evaluations: 2 }]);
    expect(rep.byCriterion.find((c) => c.label === "Saudação")).toMatchObject({ avgPct: 50, answered: 2, failed: 1 });
    expect(rep.byCriterion.find((c) => c.label === "Ficha")).toMatchObject({ avgPct: 100, answered: 1 });
  });
});

describe("métricas da transcrição", () => {
  it("fala por orador, maior silêncio, interrupções e palavras proibidas", () => {
    const m = transcriptMetrics(
      {
        source: "recording",
        durationSecs: 30,
        utterances: [
          { speaker: 0, start: 0, end: 10, text: "Bom dia" },
          { speaker: 1, start: 8, end: 12, text: "Olá" },
          { speaker: 0, start: 20, end: 30, text: "Isso NÃO É COMIGO, ok?" },
        ],
      },
      ["não é comigo", "desculpe"]
    );
    expect(m.talk).toEqual([{ speaker: 0, secs: 20, pct: 83 }, { speaker: 1, secs: 4, pct: 17 }]);
    expect(m.longestSilenceSecs).toBe(8);
    expect(m.interruptions).toBe(1);
    expect(m.forbidden).toEqual([{ word: "não é comigo", start: 20, speaker: 0 }]);
  });
});
