import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { readTable, extractRows, normalizeRows } = await import("./contactFile.service.js");

/** Ficheiro de números para campanhas: o que se lê e o que se junta. */
describe("ler o ficheiro", () => {
  it("só números, sem cabeçalho (um por linha)", () => {
    const rows = extractRows(readTable(Buffer.from("923456789\n+244 912 000 111\n"), "numeros.txt"));
    expect(rows.map((r) => r.rawPhone)).toEqual(["923456789", "+244 912 000 111"]);
    expect(rows[0]!.row).toBe(1);
  });
  it("cabeçalho Nome;Telefone com ponto e vírgula (Excel PT)", () => {
    const rows = extractRows(readTable(Buffer.from("Nome;Telefone\nMaria Silva;923 456 789\n"), "lista.csv"));
    expect(rows).toEqual([{ row: 2, rawPhone: "923 456 789", name: "Maria Silva" }]);
  });
  it("sem cabeçalho de telefone: descobre a coluna dos números e a do nome", () => {
    const rows = extractRows([["Cliente", "Contacto?"], ["João", "931000000"], ["Ana", "+244941000000"]]);
    expect(rows.map((r) => [r.name, r.rawPhone])).toEqual([["João", "931000000"], ["Ana", "+244941000000"]]);
  });
});

describe("juntar e validar", () => {
  it("o mesmo número em formatos diferentes conta uma vez; inválidos à parte", () => {
    const { unique, invalid, duplicates } = normalizeRows([
      { row: 1, rawPhone: "923456789", name: null },
      { row: 2, rawPhone: "+244923456789", name: "Maria" },
      { row: 3, rawPhone: "123", name: "Errado" },
      { row: 4, rawPhone: "", name: "Sem número" },
    ]);
    expect(unique).toEqual([{ phone: "923456789", name: "Maria", row: 1 }]);
    expect(duplicates).toBe(1);
    expect(invalid.map((i) => i.row)).toEqual([3, 4]);
  });
});
