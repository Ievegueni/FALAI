import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

/**
 * Histórico do cliente na entrada (screen pop): normalização do número,
 * cliente existente, não identificado e número oculto — mais o registo de
 * quem consultou e o contacto rápido.
 */

const contact = {
  id: "ct_1",
  name: "Maria Silva",
  phone: "+244923456789", // formato legado ainda em base
  email: null,
  attributes: { plano: "Pro" },
  optedOutAt: null,
  createdAt: new Date("2026-01-01"),
  phones: [{ id: "ph_1", phone: "912000111", label: "Trabalho" }],
};
const prisma = {
  contact: {
    findFirst: vi.fn(async (_args: any): Promise<{ id: string } | null> => ({ id: contact.id })),
    findFirstOrThrow: vi.fn(async () => contact),
    count: vi.fn(async () => 1),
    create: vi.fn(async () => ({ id: "ct_new" })),
  },
  call: {
    findMany: vi.fn(async () => [
      {
        id: "call_1",
        kind: "INBOUND",
        startedAt: new Date("2026-10-01T10:00:00Z"),
        answeredAt: new Date("2026-10-01T10:00:08Z"),
        endedAt: new Date("2026-10-01T10:02:08Z"),
        durationSecs: 120,
        status: "COMPLETED",
        group: { name: "VENDAS" },
        legs: [
          { extensionNumber: "1001", outcome: "ANSWERED", typingNote: "2.ª via", typedAt: new Date(), extension: { displayName: "Ana" }, category: { name: "Reclamação" }, subcategory: { name: "Facturação" } },
          { extensionNumber: "1000", outcome: "CANCELLED", typingNote: null, typedAt: null, extension: null, category: null, subcategory: null },
        ],
      },
    ]),
    count: vi.fn(async () => 3),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  callLeg: {
    findFirst: vi.fn(async (args: any) =>
      args.select?.callId && args.select?.call
        ? { callId: "call_9", call: { fromNumber: currentFrom } }
        : args.select?.callId
          ? { callId: "call_9" }
          : { typedAt: new Date(), typingNote: "2.ª via", category: { name: "Reclamação" }, subcategory: { name: "Facturação" } }
    ),
  },
  conversation: { findMany: vi.fn(async () => []) },
  contactNote: { findMany: vi.fn(async () => []) },
  tenantUser: { findMany: vi.fn(async () => []) },
};
let currentFrom: string | null = "+244923456789";
vi.mock("@falai/db", () => ({ prisma }));

const { classifyCaller, displayPhone, phoneVariants, historyState } = await import("./callerLookup.service.js");
const { tenantCallersRoutes } = await import("../routes/tenant/callers.js");

describe("normalização do número de origem", () => {
  it.each([
    ["+244923456789", "923456789"],
    ["244923456789", "923456789"],
    ["00244923456789", "923456789"],
    ["923 456 789", "923456789"],
  ])("%s → %s", (raw, national) => {
    const c = classifyCaller(raw);
    expect(c).toMatchObject({ kind: "NUMBER", national, display: "+244 923 456 789" });
  });
  it("internacional não se identifica, mas mostra-se tal como chegou", () => {
    expect(classifyCaller("+351912345678")).toEqual({ kind: "NUMBER", raw: "+351912345678", national: null, display: "+351912345678" });
  });
  it("procura também o formato legado gravado nos contactos antigos", () => {
    expect(phoneVariants("923456789")).toEqual(["923456789", "+244923456789", "244923456789"]);
    expect(displayPhone("912000111")).toBe("+244 912 000 111");
  });
});

describe("número oculto", () => {
  it.each([null, "", "anonymous", "Unknown", "restricted", "0", "+"])("%s → HIDDEN", (raw) => {
    expect(classifyCaller(raw)).toEqual({ kind: "HIDDEN" });
  });
});

describe("estado no histórico", () => {
  it("recusada só quando ninguém atendeu e alguém recusou", () => {
    const t = new Date();
    expect(historyState({ answeredAt: t, endedAt: t, legOutcomes: ["REJECTED", "ANSWERED"] })).toBe("ANSWERED");
    expect(historyState({ answeredAt: null, endedAt: t, legOutcomes: ["REJECTED", "NO_ANSWER"] })).toBe("REJECTED");
    expect(historyState({ answeredAt: null, endedAt: t, legOutcomes: ["NO_ANSWER"] })).toBe("MISSED");
  });
});

describe("GET /tenant/callers/lookup", () => {
  const audit = vi.fn(async () => {});
  async function app() {
    const f = Fastify();
    f.decorate("verifyTenant", async (req: any) => {
      req.tenantUser = { tenantId: "tnt_1", sub: "user_ana", role: "MEMBER" };
    });
    f.decorate("audit", audit);
    await f.register(tenantCallersRoutes);
    return f;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    currentFrom = "+244923456789";
  });

  it("cliente existente: contacto, histórico com agente/grupo/tipificação, destaques — e regista quem consultou", async () => {
    const res = await (await app()).inject({ url: "/tenant/callers/lookup?legId=leg_1" });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.caller).toMatchObject({ kind: "NUMBER", national: "923456789" });
    expect(body.contact).toMatchObject({ id: "ct_1", name: "Maria Silva", phone: "923456789" });
    expect(body.history.data[0]).toMatchObject({
      agent: "Ana",
      group: "VENDAS",
      state: "ANSWERED",
      durationSecs: 120,
      typing: "Reclamação › Facturação",
      note: "2.ª via",
    });
    expect(body.highlights).toMatchObject({ callsLast7Days: 3, lastTyping: { label: "Reclamação › Facturação" } });
    // pesquisa isolada pelo tenant, com as variantes do número
    expect(prisma.contact.findFirst.mock.calls[0]![0].where).toMatchObject({ tenantId: "tnt_1" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contact.history_viewed", actorId: "user_ana", targetId: "ct_1" }));
  });

  it("não identificado: sem contacto e sem registo de acesso", async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    const body = (await (await app()).inject({ url: "/tenant/callers/lookup?number=931000000" })).json();
    expect(body).toMatchObject({ caller: { kind: "NUMBER", display: "+244 931 000 000" }, contact: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it("número oculto: não pesquisa", async () => {
    currentFrom = "anonymous";
    const body = (await (await app()).inject({ url: "/tenant/callers/lookup?legId=leg_1" })).json();
    expect(body).toMatchObject({ caller: { kind: "HIDDEN" }, contact: null });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  it("contacto rápido: recusa número de outro contacto e liga a chamada em curso ao novo", async () => {
    const f = await app();
    const dup = await f.inject({ method: "POST", url: "/tenant/callers/contacts", payload: { name: "X", phone: "923456789" } });
    expect(dup.statusCode).toBe(409);

    prisma.contact.findFirst.mockResolvedValueOnce(null);
    const ok = await f.inject({ method: "POST", url: "/tenant/callers/contacts", payload: { name: "João", phone: "+244 931 000 000", legId: "leg_1" } });
    expect(ok.statusCode).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: "tnt_1", phone: "931000000", name: "João" } }));
    expect(prisma.call.updateMany).toHaveBeenCalledWith({ where: { id: "call_9", tenantId: "tnt_1", contactId: null }, data: { contactId: "ct_new" } });
  });
});
