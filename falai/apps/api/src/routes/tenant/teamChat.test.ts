import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { directKey } = await import("./teamChat.js");

describe("chat interno", () => {
  it("a conversa directa é a mesma quem quer que a abra", () => {
    expect(directKey("u_ana", "u_gil")).toBe(directKey("u_gil", "u_ana"));
    expect(directKey("b", "a")).toBe("a:b");
  });
});
