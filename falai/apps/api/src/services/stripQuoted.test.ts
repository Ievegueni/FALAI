import { describe, it, expect } from "vitest";
import { stripQuoted } from "./stripQuoted.js";

describe("stripQuoted", () => {
  it("corta citação, cabeçalho de resposta e assinatura", () => {
    const pt = "Obrigado, já funciona.\n\n-- \nJoão\n\nEm seg., 22/09/2026 às 10:00, Suporte <s@x.ao> escreveu:\n> Tente reiniciar.\n";
    expect(stripQuoted(pt)).toBe("Obrigado, já funciona.");
    const en = "Yes please\r\nOn Mon, Sep 22, 2026 at 10:00 AM Support <s@x.ao> wrote:\r\n> Do you want a refund?";
    expect(stripQuoted(en)).toBe("Yes please");
    const outlook = "Segue anexo.\n________________________________\nDe: Suporte\nEnviado: hoje";
    expect(stripQuoted(outlook)).toBe("Segue anexo.");
    expect(stripQuoted("> só citação")).toBe("");
  });
});
