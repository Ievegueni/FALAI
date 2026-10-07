import { describe, it, expect, vi, afterEach } from "vitest";

const lookup = vi.fn<(host: string, opts: unknown) => Promise<Array<{ address: string; family: number }>>>();
vi.mock("node:dns/promises", () => ({ lookup: (h: string, o: unknown) => lookup(h, o) }));

const { assertSafeWebhookUrl, assertPublicWebhookUrl, postWebhook } = await import("./safeWebhook.js");

const env = process.env["NODE_ENV"];
afterEach(() => {
  process.env["NODE_ENV"] = env;
  lookup.mockReset();
});

describe("assertSafeWebhookUrl", () => {
  it("https público passa", () => {
    expect(assertSafeWebhookUrl("https://hooks.cliente.ao/falai").hostname).toBe("hooks.cliente.ao");
  });

  it("http só fora de produção", () => {
    process.env["NODE_ENV"] = "development";
    expect(() => assertSafeWebhookUrl("http://hooks.cliente.ao/x")).not.toThrow();
    process.env["NODE_ENV"] = "production";
    expect(() => assertSafeWebhookUrl("http://hooks.cliente.ao/x")).toThrow(/https/);
  });

  it("recusa localhost, IPs privados, link-local e metadata", () => {
    for (const u of [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/x",
      "https://[::1]/x",
      "https://redis/x",
      "ftp://hooks.cliente.ao/x",
    ]) {
      expect(() => assertSafeWebhookUrl(u), u).toThrow();
    }
  });

  it("mensagens falam de webhook, não de modelo", () => {
    expect(() => assertSafeWebhookUrl("https://127.0.0.1/x")).toThrow(/webhook/);
  });
});

describe("assertPublicWebhookUrl (DNS)", () => {
  it("aceita nome que resolve só para IPs públicos", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicWebhookUrl("https://hooks.cliente.ao/x")).resolves.toBeInstanceOf(URL);
  });

  it("recusa nome público que resolve para interno (qualquer dos IPs)", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(assertPublicWebhookUrl("https://evil.example.com/x")).rejects.toThrow(/interno/);
  });

  it("recusa nome que não resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicWebhookUrl("https://nao-existe.example.com/x")).rejects.toThrow(/resolver/);
  });
});

describe("postWebhook", () => {
  it("recusa logo um URL interno, sem abrir ligação", async () => {
    await expect(postWebhook("https://127.0.0.1/x", {}, "{}", 1000)).rejects.toThrow();
  });
});
