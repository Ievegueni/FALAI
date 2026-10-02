import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

/**
 * Tipificação de chamadas: obrigatoriedade (prazo e bloqueio), expiração
 * ("não tipificada") e edição (com registo de quem alterou).
 */

const leg = {
  id: "leg_1",
  outcome: "ANSWERED" as string | null,
  endedAt: new Date("2026-10-02T10:00:00Z") as Date | null,
  extensionId: "ext_1",
  groupId: "grp_vendas" as string | null,
  categoryId: null as string | null,
  subcategoryId: null as string | null,
  typingNote: null as string | null,
  typedAt: null as Date | null,
  typedById: null as string | null,
  wrapUpEndsAt: null as Date | null,
  call: { fromNumber: "+244923000000" },
};
const categories = [
  { id: "cat_rec", parentId: null, name: "Reclamação", isActive: true, sortOrder: 0, groups: [] },
  { id: "sub_fact", parentId: "cat_rec", name: "Facturação", isActive: true, sortOrder: 0, groups: [] },
  { id: "cat_info", parentId: null, name: "Informação", isActive: true, sortOrder: 1, groups: [] },
  { id: "cat_sup", parentId: null, name: "Suporte técnico", isActive: true, sortOrder: 2, groups: [{ groupId: "grp_suporte" }] },
  { id: "cat_old", parentId: null, name: "Antiga", isActive: false, sortOrder: 3, groups: [] },
];
const prisma = {
  callLeg: {
    findFirst: vi.fn(async () => ({ ...leg })),
    update: vi.fn(async ({ data }: any) => Object.assign(leg, data)),
  },
  callCategory: { findMany: vi.fn(async () => categories) },
  extensionGroupMember: { findMany: vi.fn(async () => []) },
};
vi.mock("@falai/db", () => ({ prisma }));

const { typingStatus, wrapUpDeadline, wrapUpSecs, visibleCategories, validateTyping } = await import("./callTyping.service.js");
const { tenantCallTypingRoutes } = await import("../routes/tenant/callTyping.js");

const END = new Date("2026-10-02T10:00:00Z");
const at = (s: number) => new Date(END.getTime() + s * 1000);
const answered = (o: Partial<{ typedAt: Date | null; wrapUpEndsAt: Date | null }> = {}) => ({
  outcome: "ANSWERED",
  endedAt: END,
  typedAt: null,
  wrapUpEndsAt: null,
  ...o,
});

describe("obrigatoriedade", () => {
  it("obrigatória dá prazo = fim + máximo; opcional não dá prazo", () => {
    expect(wrapUpDeadline(END, { typingRequired: true, typingMaxSecs: 90 })).toEqual(at(90));
    expect(wrapUpDeadline(END, { typingRequired: false, typingMaxSecs: 90 })).toBeNull();
  });
  it("dentro do prazo e por tipificar = PENDING (a extensão não recebe chamadas)", () => {
    expect(typingStatus(answered({ wrapUpEndsAt: at(60) }), at(30))).toBe("PENDING");
  });
  it("só as atendidas se tipificam", () => {
    expect(typingStatus({ ...answered(), outcome: "REJECTED" }, at(5))).toBe("NONE");
  });
});

describe("expiração", () => {
  it("passado o prazo sem tipificar = NOT_TYPED", () => {
    expect(typingStatus(answered({ wrapUpEndsAt: at(60) }), at(61))).toBe("NOT_TYPED");
  });
  it("opcional e por tipificar conta logo como não tipificada", () => {
    expect(typingStatus(answered(), at(1))).toBe("NOT_TYPED");
  });
  it("tipificar depois do prazo passa a TYPED, mas o pós-chamada fica no prazo", () => {
    const l = answered({ wrapUpEndsAt: at(60), typedAt: at(3600) });
    expect(typingStatus(l, at(4000))).toBe("TYPED");
    expect(wrapUpSecs(l, at(4000))).toBe(60);
  });
  it("pós-chamada = fim → tipificação, separado do TMA", () => {
    expect(wrapUpSecs(answered({ wrapUpEndsAt: at(60), typedAt: at(25) }), at(100))).toBe(25);
    expect(wrapUpSecs(answered({ wrapUpEndsAt: at(60) }), at(30))).toBeNull(); // ainda a decorrer
  });
});

describe("categorias visíveis e validação", () => {
  const nodes = categories.map(({ groups, ...c }) => ({ ...c, groupIds: groups.map((g) => g.groupId) }));
  it("sem grupo vê as gerais; a restrita só no grupo dela; desactivadas nunca", () => {
    const ids = (g: string[]) => visibleCategories(nodes, new Set(g)).map((c) => c.id).sort();
    expect(ids(["grp_vendas"])).toEqual(["cat_info", "cat_rec", "sub_fact"]);
    expect(ids(["grp_suporte"])).toContain("cat_sup");
  });
  it("categoria com subcategorias exige subcategoria; a subcategoria tem de ser dela", () => {
    const v = visibleCategories(nodes, new Set());
    expect(validateTyping(v, "cat_rec", null)).toBe("Escolha a subcategoria");
    expect(validateTyping(v, "cat_rec", "sub_fact")).toBeNull();
    expect(validateTyping(v, "cat_info", null)).toBeNull();
    expect(validateTyping(v, "cat_info", "sub_fact")).toBe("Subcategoria inválida");
    expect(validateTyping(v, "cat_sup", null)).toBe("Categoria inválida"); // não é do grupo dele
  });
});

describe("edição (PUT /tenant/call-legs/:id/typing)", () => {
  const audit = vi.fn(async () => {});
  async function app() {
    const f = Fastify();
    f.decorate("verifyTenant", async (req: any) => {
      req.tenantUser = { tenantId: "tnt_1", sub: "user_ana", role: "MEMBER" };
    });
    f.decorate("audit", audit);
    await f.register(tenantCallTypingRoutes);
    return f;
  }

  beforeEach(() => {
    Object.assign(leg, { categoryId: null, subcategoryId: null, typingNote: null, typedAt: null, typedById: null });
    audit.mockClear();
  });

  it("a primeira tipificação grava quem e quando, sem entrada de auditoria", async () => {
    const f = await app();
    const res = await f.inject({ method: "PUT", url: "/tenant/call-legs/leg_1/typing", payload: { categoryId: "cat_info", note: "horário" } });
    expect(res.statusCode).toBe(200);
    expect(leg).toMatchObject({ categoryId: "cat_info", typingNote: "horário", typedById: "user_ana" });
    expect(leg.typedAt).toBeInstanceOf(Date);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corrigir regista antes/depois e quem alterou, e mantém a data original", async () => {
    const first = new Date("2026-10-02T10:00:20Z");
    Object.assign(leg, { categoryId: "cat_info", typedAt: first, typedById: "user_ana" });
    const f = await app();
    const res = await f.inject({
      method: "PUT",
      url: "/tenant/call-legs/leg_1/typing",
      payload: { categoryId: "cat_rec", subcategoryId: "sub_fact" },
    });
    expect(res.json()).toEqual({ ok: true, edited: true });
    expect(leg.typedAt).toEqual(first);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "call_leg.typing_changed",
        actorId: "user_ana",
        targetId: "leg_1",
        before: expect.objectContaining({ categoryId: "cat_info" }),
        after: expect.objectContaining({ categoryId: "cat_rec", subcategoryId: "sub_fact" }),
      })
    );
  });

  it("recusa categoria inválida e chamadas não atendidas", async () => {
    const f = await app();
    expect((await f.inject({ method: "PUT", url: "/tenant/call-legs/leg_1/typing", payload: { categoryId: "cat_rec" } })).statusCode).toBe(400);
    leg.outcome = "NO_ANSWER";
    expect((await f.inject({ method: "PUT", url: "/tenant/call-legs/leg_1/typing", payload: { categoryId: "cat_info" } })).statusCode).toBe(409);
    leg.outcome = "ANSWERED";
  });
});
