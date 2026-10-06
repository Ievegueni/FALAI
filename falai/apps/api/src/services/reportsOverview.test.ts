import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const { deltaPct, previousRange, daysBetween, topSlices } = await import("./reportsOverview.service.js");
const { renderOverviewPdf, fmtSecs } = await import("./reportsPdf.service.js");

/** Resumo dos relatórios: comparação com o período anterior, séries por dia e PDF. */

describe("variação face ao período anterior", () => {
  it("percentagem com 1 casa; sem base de comparação → null (não ∞ nem 0)", () => {
    expect(deltaPct(115, 100)).toBe(15);
    expect(deltaPct(90, 120)).toBe(-25);
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(null, 10)).toBeNull();
  });
  it("o anterior tem a mesma duração e acaba mesmo antes", () => {
    const from = new Date(2026, 8, 3, 0, 0, 0, 0);
    const to = new Date(2026, 9, 2, 23, 59, 59, 999);
    const p = previousRange(from, to);
    expect(p.to.getTime()).toBe(from.getTime() - 1);
    expect(p.to.getTime() - p.from.getTime()).toBe(to.getTime() - from.getTime());
  });
});

describe("séries por dia", () => {
  it("um ponto por dia local do intervalo, sem dia extra no início", () => {
    const days = daysBetween(new Date(2026, 8, 30, 0, 0, 0), new Date(2026, 9, 2, 23, 59, 59));
    expect(days).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});

describe("anéis", () => {
  it("no máximo 6 fatias; o resto junta-se em Outros; zeros saem", () => {
    const s = topSlices([1, 2, 3, 4, 5, 6, 7, 0].map((v, i) => ({ label: `g${i}`, value: v })));
    expect(s).toHaveLength(6);
    expect(s[5]).toEqual({ label: "Outros", value: 2 + 1 }); // ficam 7,6,5,4,3
    expect(s.some((x) => x.value === 0)).toBe(false);
  });
});

describe("PDF", () => {
  it("gera um PDF (não uma imagem) com as páginas do resumo", async () => {
    const tile = (key: string, unit: "count" | "secs") => ({ key, value: 10, previous: 8, deltaPct: 25, good: "up" as const, unit, series: [1, 3, 2] });
    const empty = { calls: { total: 0, answered: 0, missed: 0, abandoned: 0, answerRate: null, tmaSecs: null, tmeSecs: null } };
    const pdf = await renderOverviewPdf(
      {
        from: "2026-09-03T00:00:00Z",
        to: "2026-10-02T23:59:59Z",
        previousFrom: "2026-08-04T00:00:00Z",
        previousTo: "2026-09-02T23:59:59Z",
        limited: false,
        tiles: [tile("total", "count"), tile("tma", "secs")],
        donuts: { byGroup: [{ label: "VENDAS", value: 3 }], byState: [], byTyping: [] },
        daily: [{ date: "2026-10-01", total: 3, answered: 2 }],
        attendance: { byAgent: [], byGroup: [], reasons: [], typing: [], ...empty } as never,
        calls: {} as never,
      },
      "Demo Company"
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });
  it("tempos como no painel", () => {
    expect(fmtSecs(45)).toBe("45s");
    expect(fmtSecs(437)).toBe("7min 17s");
    expect(fmtSecs(78180)).toBe("21h 43min");
  });
});
