import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { mergeIntervals, overlapSecs, shiftIntervals, agentTimeRow, totalSecs, agentStateTimeline } = await import("./agentTime.service.js");

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

describe("conversa, pós-chamada e disponível", () => {
  it("disponível = ligado sem pausa, conversa nem pós-chamada", () => {
    const r = agentTimeRow(
      { id: "u", name: "A" },
      {
        sessions: [[d(8), d(12)]],
        shifts: [],
        pauses: [{ reason: null, iv: [d(9), d(10)] }],
        talk: [[d(10), d(10.5)], [d(13), d(14)]], // a segunda fora do tempo ligado (hardphone)
        wrapUps: [[d(10.5), d(10.75)]],
      },
      d(0),
      d(24)
    );
    expect(r.talkSecs).toBe(1.5 * 3600);
    expect(r.wrapUpSecs).toBe(0.25 * 3600);
    expect(r.availableSecs).toBe(4 * 3600 - 1 * 3600 - 0.5 * 3600 - 0.25 * 3600);
  });
});

describe("linha do tempo dos estados", () => {
  it("ordena, corta ao período e marca o que ainda decorre", () => {
    const t = agentStateTimeline(
      {
        sessions: [[d(-2), d(10)], [d(14), d(18)]], // a 1ª começa antes do período
        pauses: [{ iv: [d(9), d(9.5)], reason: "Break" }],
        calls: [{ iv: [d(15), d(18)], number: "923" }], // em curso (fecha em now)
        wrapUps: [],
      },
      d(0),
      d(24),
      d(18)
    );
    expect(t.map((s) => [s.state, s.from, s.to, s.detail])).toEqual([
      ["LOGGED_IN", d(0), d(10), null],
      ["PAUSED", d(9), d(9.5), "Break"],
      ["LOGGED_OUT", d(10), d(14), null],
      ["LOGGED_IN", d(14), null, null],
      ["IN_CALL", d(15), null, "923"],
    ]);
  });
});
