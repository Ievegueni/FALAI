import { describe, it, expect } from "vitest";
import { rankAgents } from "./wallboard.service.js";

const t = (s: number) => new Date(Date.UTC(2026, 9, 13, 9, 0, s));

describe("rankAgents", () => {
  it("ordena por atendidas, desempata pelo TMA e ignora pernas não atendidas", () => {
    const legs = [
      { extensionId: "a", answeredAt: t(0), endedAt: t(100) },
      { extensionId: "a", answeredAt: t(0), endedAt: t(200) },
      { extensionId: "b", answeredAt: t(0), endedAt: t(60) },
      { extensionId: "b", answeredAt: t(0), endedAt: t(60) },
      { extensionId: "c", answeredAt: t(0), endedAt: null }, // em curso
      { extensionId: "d", answeredAt: null, endedAt: t(10) }, // não atendeu
    ];
    const names = new Map([["a", "Ana"], ["b", "Bruno"], ["c", "Carla"]]);
    const r = rankAgents(legs, names, new Map([["a", [5, 4]]]));
    expect(r.map((x) => x.name)).toEqual(["Bruno", "Ana", "Carla"]);
    expect(r[1]).toMatchObject({ answered: 2, tmaSecs: 150, csatAvg: 4.5 });
    expect(r[2]).toMatchObject({ answered: 1, tmaSecs: null });
  });
});
