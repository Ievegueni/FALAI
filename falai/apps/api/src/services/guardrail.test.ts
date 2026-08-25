import { describe, it, expect, vi, beforeEach } from "vitest";

// A lista global vive em SystemSetting; aqui controlamo-la directamente.
const getSetting = vi.fn<(key: string) => Promise<string | null>>();
vi.mock("./settings.service.js", () => ({ getSetting: (k: string) => getSetting(k) }));
vi.mock("@falai/db", () => ({ prisma: {} }));

const { applyGuardrails, invalidateBannedPhrasesCache, FALLBACK_REPLY } = await import(
  "./guardrail.service.js"
);

const BASE = {
  tenantId: "tnt_1",
  callId: "call_1",
  allowedEscalationNumbers: ["+244923000000"],
};

beforeEach(() => {
  getSetting.mockReset();
  getSetting.mockResolvedValue(null);
  invalidateBannedPhrasesCache();
});

describe("applyGuardrails — resposta", () => {
  it("deixa passar uma resposta normal sem tocar nela", async () => {
    const r = await applyGuardrails(
      { reply: "Bom dia, em que posso ajudar?", action: { type: "continue" } },
      BASE
    );
    expect(r.violated).toBe(false);
    expect(r.flags).toEqual([]);
    expect(r.reply).toBe("Bom dia, em que posso ajudar?");
  });

  it("substitui uma resposta vazia pela frase de recurso", async () => {
    const r = await applyGuardrails({ reply: "   ", action: { type: "continue" } }, BASE);
    expect(r.flags).toContain("empty_reply");
    expect(r.reply).toBe(FALLBACK_REPLY);
  });

  it("trunca sem partir palavras a meio", async () => {
    const long = "palavra ".repeat(200).trim();
    const r = await applyGuardrails(
      { reply: long, action: { type: "continue" } },
      { ...BASE, maxReplyChars: 50 }
    );
    expect(r.flags).toContain("reply_too_long");
    expect(r.reply.length).toBeLessThanOrEqual(51); // +1 pela reticência
    expect(r.reply.endsWith("…")).toBe(true);
    expect(r.reply).not.toMatch(/pala…$/); // não cortou a meio de "palavra"
  });

  it("um maxReplyChars enorme não ultrapassa o tecto da plataforma", async () => {
    const long = "a".repeat(5000);
    const r = await applyGuardrails(
      { reply: long, action: { type: "continue" } },
      { ...BASE, maxReplyChars: 99999 }
    );
    expect(r.flags).toContain("reply_too_long");
    expect(r.reply.length).toBeLessThanOrEqual(1501);
  });
});

describe("applyGuardrails — frases proibidas", () => {
  it("recusa a resposta inteira quando contém uma frase da lista", async () => {
    getSetting.mockResolvedValue("garantimos lucro\noferta sem risco");
    const r = await applyGuardrails(
      { reply: "Olhe, GARANTIMOS LUCRO já no primeiro mês.", action: { type: "continue" } },
      BASE
    );
    expect(r.flags).toContain("banned_phrase");
    expect(r.reply).toBe(FALLBACK_REPLY);
  });

  it("ignora entradas demasiado curtas para serem seguras", async () => {
    getSetting.mockResolvedValue("ab");
    const r = await applyGuardrails(
      { reply: "Uma abordagem simples.", action: { type: "continue" } },
      BASE
    );
    expect(r.violated).toBe(false);
  });
});

describe("applyGuardrails — acções", () => {
  it("acção desconhecida cai para continue", async () => {
    const r = await applyGuardrails(
      { reply: "Ok.", action: { type: "transferir_tudo" } },
      BASE
    );
    expect(r.flags).toContain("invalid_action");
    expect(r.action.type).toBe("continue");
  });

  it("permite escalar para um número do tenant", async () => {
    const r = await applyGuardrails(
      { reply: "Vou passar a um colega.", action: { type: "escalate", to: "+244923000000" } },
      BASE
    );
    expect(r.violated).toBe(false);
    expect(r.action.type).toBe("escalate");
  });

  it("bloqueia escalar para um número de fora", async () => {
    const r = await applyGuardrails(
      { reply: "Vou passar.", action: { type: "escalate", to: "+244999888777" } },
      BASE
    );
    expect(r.flags).toContain("escalation_not_allowed");
    expect(r.action.type).toBe("continue");
  });

  it("bloqueia escalar sem destino", async () => {
    const r = await applyGuardrails({ reply: "Vou passar.", action: { type: "escalate" } }, BASE);
    expect(r.flags).toContain("escalation_not_allowed");
    expect(r.action.type).toBe("continue");
  });

  // O buraco que existia: com a extensão "200" na lista, qualquer número
  // acabado em 200 passava, e o modelo escolhia para onde desviar a chamada.
  it("uma extensão curta não deixa passar um número que acabe nela", async () => {
    const r = await applyGuardrails(
      { reply: "Vou passar.", action: { type: "escalate", to: "+244923000200" } },
      { ...BASE, allowedEscalationNumbers: ["200"] }
    );
    expect(r.flags).toContain("escalation_not_allowed");
    expect(r.action.type).toBe("continue");
  });

  it("um destino de um dígito não casa com nada", async () => {
    const r = await applyGuardrails(
      { reply: "Vou passar.", action: { type: "escalate", to: "2" } },
      { ...BASE, allowedEscalationNumbers: ["+244923000002"] }
    );
    expect(r.flags).toContain("escalation_not_allowed");
  });

  it("uma extensão exacta continua a ser permitida", async () => {
    const r = await applyGuardrails(
      { reply: "Passo ao colega.", action: { type: "escalate", to: "200" } },
      { ...BASE, allowedEscalationNumbers: ["200"] }
    );
    expect(r.violated).toBe(false);
    expect(r.action.type).toBe("escalate");
  });

  it("o mesmo número com e sem indicativo continua a casar", async () => {
    const r = await applyGuardrails(
      { reply: "Passo já.", action: { type: "escalate", to: "923000000" } },
      { ...BASE, allowedEscalationNumbers: ["+244923000000"] }
    );
    expect(r.violated).toBe(false);
  });

  it("bloqueia escalar quando o tenant não tem números", async () => {
    const r = await applyGuardrails(
      { reply: "Vou passar.", action: { type: "escalate", to: "+244923000000" } },
      { ...BASE, allowedEscalationNumbers: [] }
    );
    expect(r.flags).toContain("escalation_not_allowed");
  });
});

describe("cache das frases proibidas", () => {
  it("só volta a ler depois de invalidada", async () => {
    getSetting.mockResolvedValue("frase proibida");
    await applyGuardrails({ reply: "olá", action: { type: "continue" } }, BASE);
    await applyGuardrails({ reply: "olá", action: { type: "continue" } }, BASE);
    expect(getSetting).toHaveBeenCalledTimes(1);

    invalidateBannedPhrasesCache();
    await applyGuardrails({ reply: "olá", action: { type: "continue" } }, BASE);
    expect(getSetting).toHaveBeenCalledTimes(2);
  });
});
