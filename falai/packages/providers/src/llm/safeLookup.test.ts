import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Testes da camada 2 do anti-SSRF: a validação DEPOIS da resolução de DNS.
 *
 * É esta que fecha o DNS rebinding — o ataque realista contra a validação
 * sintáctica, em que `dominio-do-cliente.com` passa no guard e depois resolve
 * para um endereço interno. O DNS é mocado para o teste ser determinista.
 */

type LookupCb = (err: NodeJS.ErrnoException | null, addresses?: unknown) => void;

const dnsLookup = vi.fn<(host: string, opts: unknown, cb: LookupCb) => void>();
vi.mock("node:dns", () => ({ lookup: (h: string, o: unknown, c: LookupCb) => dnsLookup(h, o, c) }));

const { safeLookup, BlockedAddressError } = await import("./urlGuard.js");

/** Corre o safeLookup e devolve o que ele passou ao callback. */
function run(hostname: string, options: unknown = {}) {
  return new Promise<{ err: Error | null; address: unknown; family: number | undefined }>((resolve) => {
    safeLookup(hostname, options as never, (err, address, family) => {
      resolve({ err: err as Error | null, address, family });
    });
  });
}

/** Faz o DNS devolver esta lista de endereços. */
function resolvesTo(list: Array<{ address: string; family: number }>) {
  dnsLookup.mockImplementation((_h, _o, cb) => cb(null, list));
}

beforeEach(() => {
  dnsLookup.mockReset();
});

describe("safeLookup", () => {
  it("deixa passar um endereço público", async () => {
    resolvesTo([{ address: "93.184.216.34", family: 4 }]);
    const r = await run("api.exemplo.com");
    expect(r.err).toBeNull();
    expect(r.address).toBe("93.184.216.34");
    expect(r.family).toBe(4);
  });

  // O ataque que motiva este módulo: o nome passa no guard sintáctico e só na
  // resolução se percebe que aponta para a metadata da cloud.
  it("recusa um nome público que resolve para a metadata da cloud", async () => {
    resolvesTo([{ address: "169.254.169.254", family: 4 }]);
    const r = await run("modelo.cliente.com");
    expect(r.err).toBeInstanceOf(BlockedAddressError);
    expect(r.err?.message).toContain("169.254.169.254");
  });

  it("recusa quando resolve para a rede privada", async () => {
    resolvesTo([{ address: "10.1.2.3", family: 4 }]);
    expect((await run("interno.cliente.com")).err).toBeInstanceOf(BlockedAddressError);
  });

  it("recusa quando resolve para loopback", async () => {
    resolvesTo([{ address: "127.0.0.1", family: 4 }]);
    expect((await run("bonito.cliente.com")).err).toBeInstanceOf(BlockedAddressError);
  });

  it("recusa IPv6 loopback e ULA", async () => {
    resolvesTo([{ address: "::1", family: 6 }]);
    expect((await run("v6.cliente.com")).err).toBeInstanceOf(BlockedAddressError);

    resolvesTo([{ address: "fd00::1", family: 6 }]);
    expect((await run("v6.cliente.com")).err).toBeInstanceOf(BlockedAddressError);
  });

  // Um nome que devolve um endereço público e um interno é um ataque, mesmo que
  // desta vez calhasse o público — recusa-se a lista inteira.
  it("recusa se QUALQUER endereço da lista for interno", async () => {
    resolvesTo([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const r = await run("misto.cliente.com");
    expect(r.err).toBeInstanceOf(BlockedAddressError);
  });

  it("devolve a lista toda quando pedem all:true", async () => {
    const list = [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ];
    resolvesTo(list);
    const r = await run("api.exemplo.com", { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual(list);
  });

  it("propaga um erro de resolução", async () => {
    const boom: NodeJS.ErrnoException = new Error("sem DNS");
    boom.code = "EAI_AGAIN";
    dnsLookup.mockImplementation((_h, _o, cb) => cb(boom));
    const r = await run("nao-existe.exemplo.com");
    expect(r.err).toBe(boom);
  });

  it("trata uma resposta vazia como ENOTFOUND", async () => {
    resolvesTo([]);
    const r = await run("vazio.exemplo.com");
    expect((r.err as NodeJS.ErrnoException)?.code).toBe("ENOTFOUND");
  });

  it("pede sempre all:true ao DNS, mesmo quando quem chama não pediu", async () => {
    resolvesTo([{ address: "93.184.216.34", family: 4 }]);
    await run("api.exemplo.com", { family: 4 });
    expect(dnsLookup.mock.calls[0]![1]).toMatchObject({ all: true, family: 4 });
  });
});
