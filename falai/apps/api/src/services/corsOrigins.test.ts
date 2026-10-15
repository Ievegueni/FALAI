import { describe, it, expect } from "vitest";
import { parseAllowedOrigins } from "./corsOrigins.js";

const allowed = (list: (string | RegExp)[], origin: string) => list.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));

describe("parseAllowedOrigins", () => {
  const list = parseAllowedOrigins(" https://falai.comunica.ao, https://*.falai.ao ,");

  it("entradas exactas continuam exactas", () => {
    expect(allowed(list, "https://falai.comunica.ao")).toBe(true);
    expect(allowed(list, "https://x.falai.comunica.ao")).toBe(false);
  });

  it("*. aceita um nível de subdomínio e mais nada", () => {
    expect(allowed(list, "https://credito.falai.ao")).toBe(true);
    expect(allowed(list, "https://admin.falai.ao")).toBe(true);
    expect(allowed(list, "https://falai.ao")).toBe(false);
    expect(allowed(list, "https://a.b.falai.ao")).toBe(false);
    expect(allowed(list, "http://credito.falai.ao")).toBe(false);
    expect(allowed(list, "https://credito.falai.ao.evil.com")).toBe(false);
    expect(allowed(list, "https://evilfalai.ao")).toBe(false);
    expect(allowed(list, "https://credito-falai.ao")).toBe(false);
  });

  it("vazio = lista vazia", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
});
