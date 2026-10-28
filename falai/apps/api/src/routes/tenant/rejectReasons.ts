import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { isOpsManager } from "../../services/userScope.js";

/**
 * Motivos de recusa de chamadas (relatórios de atendimento, Fase 2).
 *
 * A lista é do tenant e gere-a o OWNER/ADMIN. Não se apagam motivos — só se
 * desactivam: os relatórios antigos continuam a precisar do nome.
 * O agente grava o motivo no webphone ANTES de recusar (SIP 603); a perna
 * passa a REJECTED quando o Asterisk entrega a causa — ver callLegs.service.ts.
 */

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });
const rejectSchema = z
  .object({
    reasonId: z.string().optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((b) => Boolean(b.reasonId) !== Boolean(b.note), "Escolha um motivo ou escreva-o em \"Outro\"");

export const tenantRejectReasonsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/reject-reasons — activos (webphone); ?all=1 inclui os desactivados (gestão)
  fastify.get<{ Querystring: { all?: string } }>("/tenant/reject-reasons", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const data = await prisma.rejectReason.findMany({
      where: { tenantId, ...(request.query.all ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      select: { id: true, label: true, isActive: true, sortOrder: true },
    });
    return { data };
  });

  fastify.post("/tenant/reject-reasons", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = createSchema.parse(request.body);
    const row = await prisma.rejectReason
      .create({ data: { tenantId, label: body.label, ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }) } })
      .catch(() => null);
    if (!row) return reply.status(409).send({ error: "Já existe um motivo com esse nome" });
    return reply.status(201).send(row);
  });

  fastify.patch<{ Params: { id: string } }>("/tenant/reject-reasons/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = updateSchema.parse(request.body);
    const res = await prisma.rejectReason
      .updateMany({
        where: { id: request.params.id, tenantId },
        data: {
          ...(body.label !== undefined && { label: body.label }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      })
      .catch(() => null);
    if (!res) return reply.status(409).send({ error: "Já existe um motivo com esse nome" });
    if (res.count === 0) return reply.status(404).send({ error: "Motivo não encontrado" });
    return { ok: true };
  });

  // POST /tenant/call-legs/:id/reject-reason — o agente diz porque recusou.
  // O id da perna chega ao webphone no cabeçalho X-Falai-Leg-Id do INVITE.
  fastify.post<{ Params: { id: string } }>("/tenant/call-legs/:id/reject-reason", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const body = rejectSchema.parse(request.body);
    if (body.reasonId) {
      const reason = await prisma.rejectReason.findFirst({
        where: { id: body.reasonId, tenantId, isActive: true },
        select: { id: true },
      });
      if (!reason) return reply.status(400).send({ error: "Motivo inválido" });
    }
    // Só enquanto a perna está a tocar (ou acabou de ser recusada): não se
    // reescreve o motivo de uma chamada atendida ou já fechada por outra razão.
    const res = await prisma.callLeg.updateMany({
      where: { id: request.params.id, tenantId, OR: [{ outcome: null }, { outcome: "REJECTED" }] },
      data: { rejectReasonId: body.reasonId ?? null, rejectNote: body.note ?? null },
    });
    if (res.count === 0) return reply.status(409).send({ error: "A chamada já não está a tocar" });
    return { ok: true };
  });
};
