/**
 * Filtros da página Chamadas (lista e exportação): período, direcção, tipo,
 * estado, agente de IA, campanha, extensão que atendeu, grupo, tipificação e
 * pesquisa por número ou nome do contacto. Isolado por tenant.
 */
import { z } from "zod";
import type { Prisma } from "@falai/db";

export const callsFilterSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  kind: z.enum(["AI_AGENT", "DIRECT", "OTP", "INBOUND", "FIXED_SCRIPT"]).optional(),
  status: z
    .enum(["QUEUED", "DIALING", "RINGING", "IN_PROGRESS", "COMPLETED", "NO_ANSWER", "BUSY", "FAILED", "CANCELLED", "ESCALATED"])
    .optional(),
  agentId: z.string().optional(),
  campaignId: z.string().optional(),
  extensionId: z.string().optional(), // quem atendeu (chamadas de entrada)
  groupId: z.string().optional(),
  categoryId: z.string().optional(), // tipificação (categoria ou subcategoria)
  q: z.string().trim().max(100).optional(),
});
export type CallsFilter = z.infer<typeof callsFilterSchema>;

/** Dia local "AAAA-MM-DD" → início/fim desse dia (como nos relatórios). */
export function dayBounds(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const out: { gte?: Date; lte?: Date } = {};
  if (from) out.gte = new Date(`${from}T00:00:00`);
  if (to) out.lte = new Date(`${to}T23:59:59.999`);
  return out;
}

/**
 * Pesquisa: com ≥ 3 dígitos procura o número (pelos últimos 9, para apanhar
 * +244/244/9 dígitos); sempre procura também o nome do contacto.
 */
export function searchWhere(q: string): Prisma.CallWhereInput {
  const digits = q.replace(/\D/g, "");
  const tail = digits.length > 9 ? digits.slice(-9) : digits;
  return {
    OR: [
      { contact: { name: { contains: q, mode: "insensitive" } } },
      ...(tail.length >= 3 ? [{ fromNumber: { contains: tail } }, { toNumber: { contains: tail } }] : []),
    ],
  };
}

export function callsWhere(tenantId: string, f: CallsFilter): Prisma.CallWhereInput {
  const where: Prisma.CallWhereInput = { tenantId };
  const range = dayBounds(f.from, f.to);
  if (range.gte || range.lte) where.createdAt = range;
  if (f.direction === "inbound") where.kind = "INBOUND";
  if (f.direction === "outbound") where.kind = { not: "INBOUND" };
  if (f.kind) where.kind = f.kind; // o tipo explícito ganha à direcção
  if (f.status) where.status = f.status;
  if (f.agentId) where.agentId = f.agentId;
  if (f.campaignId) where.campaignId = f.campaignId;
  if (f.groupId) where.groupId = f.groupId;

  const and: Prisma.CallWhereInput[] = [];
  if (f.q) and.push(searchWhere(f.q));
  if (f.extensionId) and.push({ legs: { some: { extensionId: f.extensionId, outcome: "ANSWERED" } } });
  if (f.categoryId) and.push({ legs: { some: { OR: [{ categoryId: f.categoryId }, { subcategoryId: f.categoryId }] } } });
  if (and.length > 0) where.AND = and;
  return where;
}

/** PBX próprio (CDR do Yeastar): só período, direcção e pesquisa por número. */
export function pbxCallsWhere(tenantId: string, f: CallsFilter): Prisma.PbxCallWhereInput {
  const range = dayBounds(f.from, f.to);
  const digits = (f.q ?? "").replace(/\D/g, "");
  const tail = digits.length > 9 ? digits.slice(-9) : digits;
  return {
    tenantId,
    ...(Object.keys(range).length > 0 && { startedAt: range }),
    ...(f.direction && { callType: f.direction === "inbound" ? "Inbound" : "Outbound" }),
    ...(tail.length >= 3 && { OR: [{ fromNumber: { contains: tail } }, { toNumber: { contains: tail } }, { fromName: { contains: f.q!, mode: "insensitive" as const } }] }),
  };
}
