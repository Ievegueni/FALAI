import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const { validateTrunkAuth } = await import("./trunk.service.js");
const { peerContextName } = await import("./asteriskRuntime.service.js");

/**
 * Peering SIP por IP (produto API_BYOM). Num trunk PEER não há utilizador nem
 * senha: o endereço É a autenticação. Estes testes fixam as duas consequências
 * disso — não se exige segredo, e não se aceita um host que não seja um IP.
 */

describe("validateTrunkAuth — REGISTER", () => {
  it("exige segredo na criação", () => {
    expect(validateTrunkAuth({ type: "REGISTER", host: "sip.operadora.com" })).toMatch(/segredo/i);
  });

  it("aceita com segredo", () => {
    expect(validateTrunkAuth({ type: "REGISTER", host: "sip.operadora.com", authSecret: "s3cr3t" })).toBeNull();
  });

  it("num update, o segredo já guardado conta", () => {
    expect(
      validateTrunkAuth({ host: "sip.operadora.com" }, { type: "REGISTER", authSecret: "guardado" }),
    ).toBeNull();
  });

  it("num update sem segredo novo nem guardado, recusa", () => {
    expect(validateTrunkAuth({ host: "x.com" }, { type: "REGISTER", authSecret: null })).toMatch(/segredo/i);
  });

  it("aceita hostname — num REGISTER o nome não é a autenticação", () => {
    expect(validateTrunkAuth({ type: "REGISTER", host: "sip.operadora.com", authSecret: "s" })).toBeNull();
  });
});

describe("validateTrunkAuth — PEER", () => {
  it("não exige segredo nenhum", () => {
    expect(validateTrunkAuth({ type: "PEER", host: "102.130.202.155" })).toBeNull();
  });

  // O ponto todo: com um nome, quem controlar a resolução passa a poder entrar.
  it("recusa um hostname", () => {
    expect(validateTrunkAuth({ type: "PEER", host: "pbx.cliente.com" })).toMatch(/endereço IP/i);
  });

  it("aceita IPv6", () => {
    expect(validateTrunkAuth({ type: "PEER", host: "2001:db8::1" })).toBeNull();
  });

  it("recusa lixo", () => {
    expect(validateTrunkAuth({ type: "PEER", host: "999.999.999.999" })).toMatch(/endereço IP/i);
  });

  it("passar um trunk existente para PEER com hostname é recusado", () => {
    expect(
      validateTrunkAuth({ type: "PEER", host: "pbx.cliente.com" }, { type: "REGISTER", authSecret: "s" }),
    ).toMatch(/endereço IP/i);
  });

  it("num update de um PEER sem mexer no host, não há nada a validar", () => {
    expect(validateTrunkAuth({ name: "novo nome" }, { type: "PEER", authSecret: "" })).toBeNull();
  });
});

describe("peerContextName", () => {
  it("gera um contexto por cliente", () => {
    expect(peerContextName("clx123abc")).toBe("from-peer-clx123abc");
  });

  // O nome acaba dentro de um ficheiro de configuração do Asterisk: nada de
  // caracteres que possam fechar a secção ou abrir outra.
  it("limpa caracteres que não são seguros num ficheiro de config", () => {
    expect(peerContextName("abc]\n[evil")).toBe("from-peer-abcevil");
    expect(peerContextName("a b/c;d")).toBe("from-peer-abcd");
  });

  it("mantém traços e underscores", () => {
    expect(peerContextName("a-b_c")).toBe("from-peer-a-b_c");
  });
});
