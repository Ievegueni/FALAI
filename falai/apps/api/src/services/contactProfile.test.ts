import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));

const { callState, profileStats, historyWhere, stateWhere, contactSearchWhere, mergeContacts, MergeError } = await import(
  "./contactProfile.service.js"
);

/**
 * Perfil do cliente (melhoria 5): agregados do resumo, filtros do histórico,
 * pesquisa normalizada e união de duplicados.
 */

const cat = (id: string, name: string) => ({ id, name });
const leg = (o: Partial<any> = {}) => ({
  extensionId: "ext_ana",
  extensionNumber: "1001",
  outcome: "ANSWERED",
  typingNote: null,
  typedAt: null,
  extension: { displayName: "Ana" },
  category: null,
  subcategory: null,
  ...o,
});
const call = (id: string, day: string, o: Partial<any> = {}) => ({
  id,
  kind: "INBOUND",
  startedAt: new Date(`${day}T10:00:00Z`),
  createdAt: new Date(`${day}T10:00:00Z`),
  answeredAt: new Date(`${day}T10:00:05Z`),
  endedAt: new Date(`${day}T10:02:05Z`),
  durationSecs: 120,
  status: "COMPLETED",
  group: { name: "VENDAS" },
  legs: [leg()],
  ...o,
});

const RECL = cat("c_recl", "Reclamação");
const FACT = cat("s_fact", "Facturação");
const INFO = cat("c_info", "Informação");

const calls = [
  call("1", "2026-09-01", { legs: [leg({ category: RECL, subcategory: FACT, typedAt: new Date("2026-09-01T10:03:00Z"), typingNote: "2.ª via" })] }),
  call("2", "2026-09-05", { legs: [leg({ category: RECL, subcategory: FACT, typedAt: new Date("2026-09-05T10:03:00Z") })] }),
  call("3", "2026-09-10", {
    legs: [leg({ extensionId: "ext_rui", extensionNumber: "1002", extension: { displayName: "Rui" }, category: INFO, typedAt: new Date("2026-09-10T10:03:00Z"), typingNote: "horário" })],
  }),
  // perdida: ninguém atendeu
  call("4", "2026-09-12", { answeredAt: null, status: "NO_ANSWER", legs: [leg({ outcome: "NO_ANSWER" })] }),
  // recusada
  call("5", "2026-09-15", { answeredAt: null, status: "NO_ANSWER", legs: [leg({ outcome: "REJECTED" })] }),
  // saída de campanha atendida (sem pernas)
  call("6", "2026-09-20", { kind: "AI_AGENT", answeredAt: null, status: "COMPLETED", legs: [] }),
];

describe("callState", () => {
  it("entrada e saída com o mesmo critério", () => {
    expect(callState({ answeredAt: new Date(), status: "COMPLETED", legOutcomes: [] })).toBe("ANSWERED");
    expect(callState({ answeredAt: null, status: "COMPLETED", legOutcomes: [] })).toBe("ANSWERED");
    expect(callState({ answeredAt: null, status: "NO_ANSWER", legOutcomes: ["REJECTED"] })).toBe("REJECTED");
    expect(callState({ answeredAt: null, status: "BUSY", legOutcomes: [] })).toBe("MISSED");
    expect(callState({ answeredAt: new Date(), status: "IN_PROGRESS", legOutcomes: [] })).toBe("IN_PROGRESS");
  });
});

describe("profileStats (resumo calculado no servidor)", () => {
  const s = profileStats(calls as never);

  it("conta atendidas, perdidas e recusadas", () => {
    expect([s.total, s.answered, s.missed, s.rejected]).toEqual([6, 4, 1, 1]);
  });

  it("primeiro e último contacto", () => {
    expect(s.firstContactAt?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(s.lastContactAt?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  it("tipificação mais frequente, última e agente que mais atendeu", () => {
    expect(s.topTyping).toEqual({ label: "Reclamação › Facturação", count: 2 });
    expect(s.lastTyping).toMatchObject({ label: "Informação", note: "horário" });
    expect(s.topAgent).toMatchObject({ extensionId: "ext_ana", name: "1001 Ana", count: 2 });
  });

  it("distribuição por categoria/subcategoria em % e linha temporal ordenada", () => {
    expect(s.typedTotal).toBe(3);
    expect(s.typings[0]).toMatchObject({ id: "c_recl", count: 2, pct: 66.7, subs: [{ id: "s_fact", count: 2, pct: 100 }] });
    expect(s.typings[1]).toMatchObject({ id: "c_info", count: 1, pct: 33.3 });
    expect(s.timeline.map((t) => t.callId)).toEqual(["1", "2", "3"]);
  });

  it("opções dos filtros vêm do próprio cliente", () => {
    expect(s.agents.map((a) => a.extensionId).sort()).toEqual(["ext_ana", "ext_rui"]);
    expect(s.categories.map((c) => c.name)).toContain("Reclamação › Facturação");
  });

  it("cliente sem chamadas", () => {
    expect(profileStats([])).toMatchObject({ total: 0, firstContactAt: null, topTyping: null, topAgent: null, typings: [] });
  });
});

describe("filtros do histórico", () => {
  it("isolado por tenant e contacto, com período, estado, tipificação e agente", () => {
    const w = historyWhere("t1", "ct1", { from: "2026-09-01", to: "2026-09-30", state: "MISSED", categoryId: "c_recl", extensionId: "ext_ana", page: 1, pageSize: 20 });
    const and = (w as any).AND;
    expect(and[0]).toEqual({ tenantId: "t1", contactId: "ct1" });
    expect(and[1].startedAt.gte).toBeInstanceOf(Date);
    expect(and[2]).toEqual(stateWhere("MISSED"));
    expect(JSON.stringify(and[3])).toContain("c_recl");
    expect(and[4]).toEqual({ legs: { some: { extensionId: "ext_ana", outcome: "ANSWERED" } } });
  });

  it("sem filtros: só tenant e contacto", () => {
    expect(historyWhere("t1", "ct1", { page: 1, pageSize: 20 })).toEqual({ AND: [{ tenantId: "t1", contactId: "ct1" }] });
  });

  it("recusada e perdida excluem-se pela perna REJECTED", () => {
    expect(JSON.stringify(stateWhere("REJECTED"))).toContain('"some":{"outcome":"REJECTED"}');
    expect(JSON.stringify(stateWhere("MISSED"))).toContain('"NOT":{"legs"');
  });
});

describe("pesquisa de clientes", () => {
  it("número completo em qualquer formato → procura exacta das variantes, também nos extra", () => {
    for (const q of ["+244 923 456 789", "923456789", "00244923456789"]) {
      const w = contactSearchWhere("t1", q) as any;
      expect(w.tenantId).toBe("t1");
      expect(w.OR[0].phone.in).toEqual(["923456789", "+244923456789", "244923456789"]);
      expect(w.OR[1].phones.some.phone.in).toContain("923456789");
    }
  });

  it("nome ou parte do número → contains (índice trigram)", () => {
    const w = contactSearchWhere("t1", "Maria 456") as any;
    expect(w.OR[0]).toEqual({ name: { contains: "Maria 456", mode: "insensitive" } });
    expect(w.OR[1]).toEqual({ phone: { contains: "456" } });
    expect((contactSearchWhere("t1", "Maria") as any).OR).toHaveLength(1);
  });
});

describe("mergeContacts (unir duplicados)", () => {
  function fakeTx(keep: any, drop: any, keepCampaigns: string[] = []) {
    const count = (n: number) => vi.fn(async () => ({ count: n }));
    return {
      contact: {
        findFirst: vi.fn(async ({ where }: any) => (where.id === keep?.id ? keep : where.id === drop?.id ? drop : null)),
        delete: vi.fn(async () => drop),
        update: vi.fn(async () => keep),
      },
      call: { updateMany: count(7) },
      smsMessage: { updateMany: count(2) },
      conversation: { updateMany: count(1) },
      contactNote: { updateMany: count(3) },
      supervisionEvent: { updateMany: count(0) },
      contactPhone: { updateMany: count(1), findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      ticket: { updateMany: count(2) },
      campaignContact: {
        findMany: vi.fn(async () => keepCampaigns.map((campaignId) => ({ campaignId }))),
        deleteMany: vi.fn(async () => ({ count: keepCampaigns.length })),
        updateMany: count(4),
      },
    };
  }
  const keep = { id: "k", name: "Maria Silva", phone: "923456789", email: null, telegramId: null, attributes: { plano: "Pro" }, optedOutAt: null, optOutReason: null };
  const drop = { id: "d", name: "Maria", phone: "+244912000111", email: "maria@x.ao", telegramId: null, attributes: { nif: "123", plano: "Basic" }, optedOutAt: new Date("2026-01-01"), optOutReason: "STOP" };

  it("move o histórico, guarda o número como extra e completa o que faltar", async () => {
    const tx = fakeTx(keep, drop, ["camp_1"]);
    const res = await mergeContacts(tx as never, "t1", "k", "d");

    for (const m of [tx.call, tx.smsMessage, tx.conversation, tx.contactNote, tx.supervisionEvent, tx.contactPhone, tx.ticket]) {
      expect(m.updateMany).toHaveBeenCalledWith({ where: { tenantId: "t1", contactId: "d" }, data: { contactId: "k" } });
    }
    // a mesma campanha nos dois: fica só a do que fica
    expect(tx.campaignContact.deleteMany).toHaveBeenCalledWith({ where: { contactId: "d", campaignId: { in: ["camp_1"] } } });
    expect(tx.contact.delete).toHaveBeenCalledWith({ where: { id: "d" } });
    // número do duplicado (formato legado) entra normalizado como extra
    expect(tx.contactPhone.create).toHaveBeenCalledWith({ data: { tenantId: "t1", contactId: "k", phone: "912000111", label: "Unido" } });
    const data = (tx.contact.update.mock.calls.at(-1) as any)[0].data;
    expect(data.name).toBeUndefined(); // o que fica já tem nome
    expect(data.email).toBe("maria@x.ao");
    expect(data.attributes).toEqual({ nif: "123", plano: "Pro" }); // os do que fica ganham
    expect(data.optedOutAt).toEqual(drop.optedOutAt); // opt-out respeita-se
    expect(res.moved).toMatchObject({ calls: 7, sms: 2, notes: 3, campaigns: 4 });
    expect(res.dropped).toBe(drop);
  });

  it("recusa o mesmo contacto ou um de outro tenant", async () => {
    await expect(mergeContacts(fakeTx(keep, drop) as never, "t1", "k", "k")).rejects.toBeInstanceOf(MergeError);
    await expect(mergeContacts(fakeTx(keep, null) as never, "t1", "k", "x")).rejects.toThrow("Contacto não encontrado");
  });
});
