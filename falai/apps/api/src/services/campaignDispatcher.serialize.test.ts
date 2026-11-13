import { describe, it, expect, vi } from "vitest";

// findFirst lento que mede quantos processNow estão dentro ao mesmo tempo.
let inside = 0;
let maxInside = 0;
const findFirst = vi.fn(async () => {
  inside++;
  maxInside = Math.max(maxInside, inside);
  await new Promise((r) => setTimeout(r, 20));
  inside--;
  return null; // sem campanha: processNow termina aqui
});

vi.mock("@falai/db", () => ({ prisma: { campaign: { findFirst } }, releaseCallReservation: vi.fn() }));

const { CampaignDispatcher } = await import("./campaignDispatcher.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("CampaignDispatcher: fila única", () => {
  it("vários processNow em simultâneo correm um de cada vez", async () => {
    const d = new CampaignDispatcher({} as never, {} as never, log);
    await Promise.all(["a", "b", "c", "d", "e"].map((id) => d.processNow(id)));
    expect(findFirst).toHaveBeenCalledTimes(5);
    expect(maxInside).toBe(1);
  });

  it("um erro num processNow não bloqueia os seguintes", async () => {
    const d = new CampaignDispatcher({} as never, {} as never, log);
    findFirst.mockRejectedValueOnce(new Error("bd em baixo"));
    await expect(d.processNow("x")).rejects.toThrow("bd em baixo");
    await expect(d.processNow("y")).resolves.toBeUndefined();
  });
});
