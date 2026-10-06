import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
vi.mock("./sms.service.js", () => ({ sendSms: vi.fn() }));
const { bucketKey, bucketRows, volumeByChannel, textFirstResponseSecs } = await import("./consolidated.service.js");

/** Consolidado: períodos, volume por canal e primeira resposta no texto. */

const d = (day: number, h = 10) => new Date(2026, 9, day, h, 0, 0); // Outubro 2026, hora local

describe("períodos", () => {
  it("dia, semana (começa à segunda) e mês", () => {
    expect(bucketKey(d(8), "day")).toBe("2026-10-08");
    expect(bucketKey(d(8), "week")).toBe("2026-10-05"); // quinta → segunda 05
    expect(bucketKey(d(11), "week")).toBe("2026-10-05"); // domingo ainda é da semana de 05
    expect(bucketKey(d(12), "week")).toBe("2026-10-12");
    expect(bucketKey(d(8), "month")).toBe("2026-10");
  });
});

describe("série", () => {
  it("chamadas, conversas e tickets no período certo; o ticket resolvido conta no dia em que resolveu", () => {
    const rows = bucketRows(
      {
        inbound: [
          { startedAt: d(5), createdAt: d(5), queuedAt: d(5), answeredAt: d(5), endedAt: d(5) },
          { startedAt: d(5), createdAt: d(5), queuedAt: d(5), answeredAt: null, endedAt: d(5) },
          { startedAt: d(6), createdAt: d(6), queuedAt: null, answeredAt: null, endedAt: d(6) }, // desligou no IVR
        ],
        outbound: [{ createdAt: d(6) }],
        conversations: [{ id: "c", createdAt: d(5), channel: "WHATSAPP", status: "RESOLVED", firstHumanAt: null, firstReplyAt: null }],
        tickets: [{ createdAt: d(5), resolvedAt: d(7), status: "RESOLVED" }],
      },
      "day"
    );
    expect(rows).toEqual([
      { period: "2026-10-05", callsIn: 2, callsAnswered: 1, callsMissed: 1, callsOut: 0, conversations: 1, conversationsResolved: 1, ticketsCreated: 1, ticketsResolved: 0 },
      { period: "2026-10-06", callsIn: 1, callsAnswered: 0, callsMissed: 0, callsOut: 1, conversations: 0, conversationsResolved: 0, ticketsCreated: 0, ticketsResolved: 0 },
      { period: "2026-10-07", callsIn: 0, callsAnswered: 0, callsMissed: 0, callsOut: 0, conversations: 0, conversationsResolved: 0, ticketsCreated: 0, ticketsResolved: 1 },
    ]);
  });
});

describe("canais e texto", () => {
  const conv = (channel: string, human: Date | null, reply: Date | null) => ({ id: channel, createdAt: d(5), channel, status: "OPEN", firstHumanAt: human, firstReplyAt: reply });

  it("voz + cada canal de texto, do maior para o menor, sem zeros", () => {
    expect(volumeByChannel(3, [conv("WHATSAPP", null, null), conv("WHATSAPP", null, null), conv("EMAIL", null, null)])).toEqual([
      { channel: "VOICE", contacts: 3 },
      { channel: "WHATSAPP", contacts: 2 },
      { channel: "EMAIL", contacts: 1 },
    ]);
    expect(volumeByChannel(0, [])).toEqual([]);
  });

  it("primeira resposta: média das conversas com pergunta e resposta", () => {
    expect(textFirstResponseSecs([conv("W", d(5, 10), d(5, 11)), conv("W", d(5, 10), null), conv("W", d(5, 10), new Date(d(5, 10).getTime() + 60_000))])).toBe(1830);
  });
});
