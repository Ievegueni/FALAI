import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { keywords, pickArticles } = await import("./knowledge.service.js");

/** Base de conhecimento: que artigos são relevantes para uma pergunta. */

const art = (id: string, title: string, body: string) => ({ id, title, body });
const articles = [
  art("fact", "Segunda via da factura", "Para pedir a segunda via, aceda à área de cliente e escolha Facturas."),
  art("net", "Internet lenta", "Reinicie o router. Se a internet continuar lenta, verifique a cobertura."),
  art("pag", "Formas de pagamento", "Aceitamos Multicaixa Express, referência e transferência. A factura chega por email."),
];

describe("palavras-chave", () => {
  it("sem acentos, sem maiúsculas, sem palavras vazias nem repetidas", () => {
    expect(keywords("Olá! A minha FACTURA não chegou, a factura de Março")).toEqual(["factura", "chegou", "marco"]);
  });
});

describe("relevância", () => {
  it("o título vale mais do que o texto", () => {
    expect(pickArticles("preciso da segunda via da factura", articles).map((a) => a.id)).toEqual(["fact", "pag"]);
  });

  it("acentos e maiúsculas não contam", () => {
    expect(pickArticles("A INTERNET está LENTA", articles)[0]!.id).toBe("net");
  });

  it("pergunta sem nada a ver não devolve artigos", () => {
    expect(pickArticles("bom dia, obrigado", articles)).toEqual([]);
    expect(pickArticles("horário das lojas", articles)).toEqual([]);
  });

  it("no máximo n artigos", () => {
    expect(pickArticles("factura pagamento internet router", articles, 2)).toHaveLength(2);
  });
});
