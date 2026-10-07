import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { mergeIntervals, overlapSecs, shiftIntervals, agentTimeRow, totalSecs } = await import("./agentTime.service.js");

/** Tempo dos agentes: ligado, escalado, aderência e pausas. */

const H = 3600_000;
const d = (h: number) => new Date(2026, 9, 5, 0, 0, 0).getTime() + h * H; // segunda 05/10/2026, hora local

describe("intervalos", () => {
  it("junta sobreposições (dois separadores) e corta ao período", () => {
    expect(mergeIntervals([[d(9), d(11)], [d(10), d(12)], [d(14), d(15)], [d(20), d(30)]], d(0), d(24))).toEqual([
      [d(9), d(12)],
      [d(14), d(15)],
      [d(20), d(24)],
    ]);
  });

  it("tempo comum entre ligado e turno", () => {
    expect(overlapSecs([[d(8), d(10)], [d(13), d(18)]], [[d(9), d(17)]])).toBe(5 * 3600); // 9–10 + 13–17
  });

  it("turnos semanais viram intervalos só nos dias certos", () => {
    const shifts = [{ weekday: 1, startMin: 9 * 60, endMin: 17 * 60 }]; // segundas 09:00–17:00
    const iv = shiftIntervals(shifts, new Date(d(0)), new Date(d(24 * 7 + 23))); // 8 dias: duas segundas
    expect(iv).toEqual([[d(9), d(17)], [d(24 * 7 + 9), d(24 * 7 + 17)]]);
    expect(totalSecs(iv)).toBe(16 * 3600);
  });
});

describe("linha do agente", () => {
  it("escalado 8 h, ligado 7 h (6 h dentro do turno), 1 h de pausa por motivo", () => {
    const row = agentTimeRow(
      { id: "u1", name: "Ana" },
      {
        sessions: [[d(8), d(12)], [d(13), d(16)]],
        shifts: [[d(9), d(17)]],
        pauses: [
          { reason: "Almoço", iv: [d(12), d(12.75)] },
          { reason: "Almoço", iv: [d(15), d(15.25)] },
          { reason: null, iv: [d(10), d(10)] }, // zero: não conta
        ],
      },
      d(0),
      d(24)
    );
    expect(row).toMatchObject({ scheduledSecs: 8 * 3600, loggedSecs: 7 * 3600, loggedInShiftSecs: 6 * 3600, adherencePct: 75, pausedSecs: 3600 });
    expect(row.pauses).toEqual([{ reason: "Almoço", secs: 3600, count: 2 }]);
  });

  it("sem turno não há aderência", () => {
    expect(agentTimeRow({ id: "u", name: "x" }, { sessions: [], shifts: [], pauses: [] }, d(0), d(24)).adherencePct).toBeNull();
  });
});
