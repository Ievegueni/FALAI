import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
// Só a lógica pura: cortar as dependências pesadas (env, BD, LLM).
for (const m of ["./crypto.service.js", "./TurnProcessor.js", "./modelResolver.service.js", "./email.service.js", "./billing.service.js", "./webhookEmitter.service.js", "./features.js"]) {
  vi.doMock(m, () => ({}));
}

const { classifyError, classifyStatus } = await import("./waPool.service.js");
const { WhatsappApiError } = await import("./textChannels.service.js");

const err = (code: number | null, http = 400) => new WhatsappApiError("x", code, http);

describe("classificação do pool WhatsApp", () => {
  it("estado do número na Meta", () => {
    expect(classifyStatus("CONNECTED")).toBe("ok");
    expect(classifyStatus("BANNED")).toBe("fatal");
    expect(classifyStatus("RESTRICTED")).toBe("suspect");
    expect(classifyStatus("FLAGGED")).toBe("warn");
    expect(classifyStatus("ALGO_NOVO")).toBe("ignore");
    expect(classifyStatus(undefined)).toBe("ignore");
  });

  it("só erros do próprio número contam — falhas globais nunca trocam de número", () => {
    expect(classifyError(err(131031))).toBe("fatal");
    expect(classifyError(err(368))).toBe("suspect");
    expect(classifyError(err(190, 401))).toBe("ignore"); // token
    expect(classifyError(err(130429, 429))).toBe("ignore"); // rate limit
    expect(classifyError(err(null, 503))).toBe("ignore"); // Meta em baixo
    expect(classifyError(new TypeError("fetch failed"))).toBe("ignore"); // rede
  });
});
