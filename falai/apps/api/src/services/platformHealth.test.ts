import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
vi.mock("@falai/providers", () => ({ trunkEndpointId: (n: string) => n }));
vi.mock("./asteriskStatus.service.js", () => ({ getAsteriskStatus: vi.fn() }));
vi.mock("./webhookEmitter.service.js", () => ({ emitWebhookAsync: vi.fn() }));
const { applyChecks } = await import("./platformHealth.service.js");
type State = Parameters<typeof applyChecks>[0];

/** Vigilância: uma falha isolada não alarma; recupera logo. */

const t0 = new Date("2026-10-07T10:00:00Z");
const chk = (ok: boolean, key = "telephony" as const) => [{ key, ok, detail: ok ? null : "ARI sem resposta", tenantId: null }];

describe("transições", () => {
  it("1.ª falha não muda nada; 2.ª seguida passa a em baixo; 3.ª não repete o aviso", () => {
    const s: State = new Map();
    expect(applyChecks(s, chk(false), t0)).toEqual([]);
    expect(applyChecks(s, chk(false), t0)).toEqual([{ key: "telephony", up: false, detail: "ARI sem resposta", tenantId: null }]);
    expect(applyChecks(s, chk(false), t0)).toEqual([]);
    expect(s.get("telephony")?.up).toBe(false);
  });

  it("volta a cima à 1.ª verificação boa, e só avisa uma vez", () => {
    const s: State = new Map();
    applyChecks(s, chk(false), t0);
    applyChecks(s, chk(false), t0);
    expect(applyChecks(s, chk(true), t0)).toEqual([{ key: "telephony", up: true, detail: null, tenantId: null }]);
    expect(applyChecks(s, chk(true), t0)).toEqual([]);
  });

  it("uma falha isolada entre boas não alarma (o contador volta a zero)", () => {
    const s: State = new Map();
    applyChecks(s, chk(false), t0);
    applyChecks(s, chk(true), t0);
    expect(applyChecks(s, chk(false), t0)).toEqual([]);
  });
});
