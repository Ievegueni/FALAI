import { describe, it, expect, afterEach } from "vitest";
import { assertSafeEndpointUrl, isSafeEndpointUrl, ALLOWED_ENDPOINT_PORTS } from "./urlGuard.js";

afterEach(() => {
  delete process.env.ALLOW_INSECURE_MODEL_ENDPOINTS;
});

describe("assertSafeEndpointUrl — aceita", () => {
  it("aceita um host público normal em https", () => {
    const url = assertSafeEndpointUrl("https://api.exemplo.com/v1/turn");
    expect(url.host).toBe("api.exemplo.com");
    expect(url.pathname).toBe("/v1/turn");
  });

  it("aceita portas alternativas permitidas", () => {
    for (const port of ALLOWED_ENDPOINT_PORTS) {
      if (port === 80) continue; // 80 só com http, coberto abaixo
      expect(isSafeEndpointUrl(`https://api.exemplo.com:${port}/turn`)).toBe(true);
    }
  });

  it("aceita um IP público literal", () => {
    expect(isSafeEndpointUrl("https://8.8.8.8/turn")).toBe(true);
  });
});

describe("assertSafeEndpointUrl — protocolo", () => {
  it("recusa http por omissão", () => {
    expect(() => assertSafeEndpointUrl("http://api.exemplo.com/turn")).toThrow(/https/i);
  });

  it("permite http quando ALLOW_INSECURE_MODEL_ENDPOINTS=true", () => {
    process.env.ALLOW_INSECURE_MODEL_ENDPOINTS = "true";
    expect(isSafeEndpointUrl("http://api.exemplo.com/turn")).toBe(true);
  });

  it("recusa protocolos exóticos mesmo em modo inseguro", () => {
    process.env.ALLOW_INSECURE_MODEL_ENDPOINTS = "true";
    expect(isSafeEndpointUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeEndpointUrl("gopher://api.exemplo.com/")).toBe(false);
  });
});

describe("assertSafeEndpointUrl — ranges internos IPv4", () => {
  it("recusa a metadata da cloud (169.254.169.254)", () => {
    expect(() => assertSafeEndpointUrl("https://169.254.169.254/latest/meta-data/")).toThrow(
      /interno/i,
    );
  });

  it("recusa 10.x", () => {
    expect(isSafeEndpointUrl("https://10.1.2.3/turn")).toBe(false);
  });

  it("recusa 172.16/12, 192.168/16, 127/8, 0.0.0.0/8 e CGNAT", () => {
    expect(isSafeEndpointUrl("https://172.16.0.1/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://172.31.255.254/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://192.168.1.1/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://127.0.0.1/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://0.0.0.0/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://100.100.1.1/turn")).toBe(false);
  });

  it("aceita 172.32.x, que está fora do bloco privado", () => {
    expect(isSafeEndpointUrl("https://172.32.0.1/turn")).toBe(true);
  });
});

describe("assertSafeEndpointUrl — ranges internos IPv6", () => {
  it("recusa a metadata embrulhada em IPv6 (::ffff:169.254.169.254)", () => {
    expect(() => assertSafeEndpointUrl("https://[::ffff:169.254.169.254]/turn")).toThrow(/interno/i);
  });

  it("recusa loopback, ULA, link-local e ::", () => {
    expect(isSafeEndpointUrl("https://[::1]/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://[fc00::1]/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://[fd12:3456::1]/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://[fe80::1]/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://[::]/turn")).toBe(false);
  });

  it("aceita um IPv6 público", () => {
    expect(isSafeEndpointUrl("https://[2001:4860:4860::8888]/turn")).toBe(true);
  });
});

describe("assertSafeEndpointUrl — hostnames internos", () => {
  it("recusa localhost e subdomínios", () => {
    expect(isSafeEndpointUrl("https://localhost/turn")).toBe(false);
    expect(isSafeEndpointUrl("https://api.localhost/turn")).toBe(false);
  });

  it("recusa *.internal e metadata.google.internal", () => {
    expect(isSafeEndpointUrl("https://metadata.google.internal/computeMetadata/v1/")).toBe(false);
    expect(isSafeEndpointUrl("https://redis.internal/turn")).toBe(false);
  });

  it("recusa nomes sem ponto (serviços da rede interna)", () => {
    expect(isSafeEndpointUrl("https://postgres/turn")).toBe(false);
  });
});

describe("assertSafeEndpointUrl — outras regras", () => {
  it("recusa credenciais embutidas no URL", () => {
    expect(() => assertSafeEndpointUrl("https://user:pass@api.exemplo.com/turn")).toThrow(
      /credenciais/i,
    );
  });

  it("recusa portas fora da lista", () => {
    expect(() => assertSafeEndpointUrl("https://api.exemplo.com:6379/turn")).toThrow(/Porta/i);
    expect(isSafeEndpointUrl("https://api.exemplo.com:5432/turn")).toBe(false);
  });

  it("recusa URL vazio ou inválido", () => {
    expect(isSafeEndpointUrl("")).toBe(false);
    expect(isSafeEndpointUrl("nao-e-um-url")).toBe(false);
  });
});
