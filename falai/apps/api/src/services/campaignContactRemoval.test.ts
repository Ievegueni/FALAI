import { describe, expect, it } from "vitest";
import { isRemovable, planRemoval } from "./campaignContactRemoval.js";

describe("isRemovable", () => {
  it("aceita contactos já tentados (FAILED, COMPLETED) e os que nunca foram marcados", () => {
    for (const s of ["PENDING", "QUEUED", "OPTED_OUT", "FAILED", "COMPLETED", "SKIPPED"]) {
      expect(isRemovable(s)).toBe(true);
    }
  });

  it("recusa contactos com chamada a decorrer", () => {
    expect(isRemovable("IN_PROGRESS")).toBe(false);
  });
});

describe("planRemoval", () => {
  it("remove um FAILED (caso da campanha transferida) e explica os que ficam", () => {
    const plan = planRemoval(
      ["failed", "busy", "missing"],
      [
        { id: "cc1", contactId: "failed", status: "FAILED" },
        { id: "cc2", contactId: "busy", status: "IN_PROGRESS" },
      ],
    );
    expect(plan.removable.map((c) => c.id)).toEqual(["cc1"]);
    expect(plan.skipped).toEqual([
      { contactId: "busy", reason: "IN_PROGRESS" },
      { contactId: "missing", reason: "NOT_IN_CAMPAIGN" },
    ]);
  });

  it("ids repetidos no pedido contam uma vez", () => {
    const plan = planRemoval(["a", "a"], [{ id: "cc1", contactId: "a", status: "PENDING" }]);
    expect(plan.removable).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });
});
