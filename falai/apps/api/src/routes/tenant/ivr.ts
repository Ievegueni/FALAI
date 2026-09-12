/**
 * Gestão dos menus de atendimento automático (IVR). Um menu liga-se a um número
 * criando uma InboundRoute com destType "IVR" e destValue = id do menu; o
 * encaminhamento em si está em services/ivr.service.ts.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";

/**
 * Nome do ficheiro de som, tal como está no Asterisk. Só letras, dígitos, "_" e
 * "-": o valor é interpolado no media do ARI ("sound:custom/<nome>"), por isso
 * uma barra ou ".." aqui seria uma forma de tocar (ou ir buscar) ficheiros fora
 * da pasta de sons.
 */
const promptName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Nome de áudio inválido (use letras, dígitos, _ ou -)");

const option = z.object({
  digit: z.string().regex(/^[0-9*#]$/, "Tecla inválida"),
  // Só EXTENSION está implementado no encaminhamento. Aceitar aqui um destino
  // que o router não sabe tratar era criar menus que desligam a chamada.
  destType: z.literal("EXTENSION").default("EXTENSION"),
  destValue: z.string().min(1).max(32),
  label: z.string().max(64).optional().nullable(),
});

const menuCreate = z.object({
  name: z.string().min(2).max(64),
  greetingPrompt: promptName,
  invalidPrompt: promptName.optional().nullable(),
  timeoutSecs: z.number().int().min(1).max(30).optional(),
  maxRetries: z.number().int().min(1).max(5).optional(),
  timeoutDestType: z.literal("EXTENSION").optional().nullable(),
  timeoutDestValue: z.string().min(1).max(32).optional().nullable(),
  options: z.array(option).min(1).max(12),
});
const menuUpdate = menuCreate.partial();

export const tenantIvrRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  function requireManager(role: string, reply: FastifyReply): boolean {
    if (role !== "OWNER" && role !== "ADMIN") {
      reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir menus de IVR" });
      return false;
    }
    return true;
  }

  /** Uma tecla só pode levar a um sítio. */
  function duplicateDigit(options: { digit: string }[]): string | null {
    const seen = new Set<string>();
    for (const o of options) {
      if (seen.has(o.digit)) return o.digit;
      seen.add(o.digit);
    }
    return null;
  }

  /**
   * Todas as extensões referidas existem neste cliente? Sem isto criava-se um
   * menu cuja tecla não leva a lado nenhum — e isso só se descobria com um
   * cliente ao telefone.
   */
  async function missingExtension(
    tenantId: string,
    numbers: string[]
  ): Promise<string | null> {
    const wanted = [...new Set(numbers)];
    if (wanted.length === 0) return null;
    const found = await prisma.extension.findMany({
      where: { tenantId, number: { in: wanted }, isActive: true },
      select: { number: true },
    });
    const have = new Set(found.map((e) => e.number));
    return wanted.find((n) => !have.has(n)) ?? null;
  }

  const shape = (m: {
    id: string;
    name: string;
    greetingPrompt: string;
    invalidPrompt: string | null;
    timeoutSecs: number;
    maxRetries: number;
    timeoutDestType: string | null;
    timeoutDestValue: string | null;
    options: { digit: string; destType: string; destValue: string; label: string | null }[];
  }) => ({
    id: m.id,
    name: m.name,
    greetingPrompt: m.greetingPrompt,
    invalidPrompt: m.invalidPrompt,
    timeoutSecs: m.timeoutSecs,
    maxRetries: m.maxRetries,
    timeoutDestType: m.timeoutDestType,
    timeoutDestValue: m.timeoutDestValue,
    options: m.options
      .slice()
      .sort((a, b) => a.digit.localeCompare(b.digit))
      .map((o) => ({ digit: o.digit, destType: o.destType, destValue: o.destValue, label: o.label })),
  });

  const include = {
    options: { select: { digit: true, destType: true, destValue: true, label: true } },
  } as const;

  fastify.get("/menus", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const menus = await prisma.ivrMenu.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      include,
    });
    return menus.map(shape);
  });

  fastify.get<{ Params: { id: string } }>("/menus/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const menu = await prisma.ivrMenu.findFirst({ where: { id: request.params.id, tenantId }, include });
    if (!menu) return reply.status(404).send({ error: "Menu não encontrado" });
    return shape(menu);
  });

  fastify.post("/menus", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = menuCreate.parse(request.body);

    const dup = duplicateDigit(body.options);
    if (dup) return reply.status(400).send({ error: `Tecla ${dup} repetida` });

    const targets = body.options.map((o) => o.destValue);
    if (body.timeoutDestValue) targets.push(body.timeoutDestValue);
    const missing = await missingExtension(tenantId, targets);
    if (missing) return reply.status(400).send({ error: `Extensão ${missing} não existe ou está inactiva` });

    const exists = await prisma.ivrMenu.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (exists) return reply.status(409).send({ error: "Já existe um menu com esse nome" });

    const menu = await prisma.ivrMenu.create({
      data: {
        tenantId,
        name: body.name,
        greetingPrompt: body.greetingPrompt,
        invalidPrompt: body.invalidPrompt ?? null,
        ...(body.timeoutSecs !== undefined ? { timeoutSecs: body.timeoutSecs } : {}),
        ...(body.maxRetries !== undefined ? { maxRetries: body.maxRetries } : {}),
        timeoutDestType: body.timeoutDestType ?? null,
        timeoutDestValue: body.timeoutDestValue ?? null,
        options: {
          create: body.options.map((o) => ({
            digit: o.digit,
            destType: o.destType,
            destValue: o.destValue,
            label: o.label ?? null,
          })),
        },
      },
    });
    await fastify.audit({
      actorType: "TENANT_USER", actorId: sub, action: "tenant.ivr_menu.created",
      targetType: "IvrMenu", targetId: menu.id, ip: request.ip,
    });
    return reply.status(201).send({ id: menu.id });
  });

  fastify.put<{ Params: { id: string } }>("/menus/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = menuUpdate.parse(request.body);

    const existing = await prisma.ivrMenu.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Menu não encontrado" });

    if (body.options) {
      const dup = duplicateDigit(body.options);
      if (dup) return reply.status(400).send({ error: `Tecla ${dup} repetida` });
    }
    const targets = (body.options ?? []).map((o) => o.destValue);
    if (body.timeoutDestValue) targets.push(body.timeoutDestValue);
    const missing = await missingExtension(tenantId, targets);
    if (missing) return reply.status(400).send({ error: `Extensão ${missing} não existe ou está inactiva` });

    await prisma.$transaction(async (tx) => {
      if (body.options !== undefined) {
        await tx.ivrOption.deleteMany({ where: { menuId: existing.id } });
        await tx.ivrOption.createMany({
          data: body.options.map((o) => ({
            menuId: existing.id,
            digit: o.digit,
            destType: o.destType,
            destValue: o.destValue,
            label: o.label ?? null,
          })),
        });
      }
      await tx.ivrMenu.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.greetingPrompt !== undefined ? { greetingPrompt: body.greetingPrompt } : {}),
          ...(body.invalidPrompt !== undefined ? { invalidPrompt: body.invalidPrompt } : {}),
          ...(body.timeoutSecs !== undefined ? { timeoutSecs: body.timeoutSecs } : {}),
          ...(body.maxRetries !== undefined ? { maxRetries: body.maxRetries } : {}),
          ...(body.timeoutDestType !== undefined ? { timeoutDestType: body.timeoutDestType } : {}),
          ...(body.timeoutDestValue !== undefined ? { timeoutDestValue: body.timeoutDestValue } : {}),
        },
      });
    });
    await fastify.audit({
      actorType: "TENANT_USER", actorId: sub, action: "tenant.ivr_menu.updated",
      targetType: "IvrMenu", targetId: existing.id, ip: request.ip,
    });
    return { ok: true };
  });

  fastify.delete<{ Params: { id: string } }>("/menus/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const existing = await prisma.ivrMenu.findFirst({ where: { id: request.params.id, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Menu não encontrado" });

    // Apagar um menu ainda ligado a um número deixava esse número a atender e a
    // desligar — o chamador ouvia "sem serviço" sem ninguém perceber porquê.
    const inUse = await prisma.inboundRoute.findFirst({
      where: { tenantId, destType: "IVR", destValue: existing.id },
      select: { name: true },
    });
    if (inUse) {
      return reply.status(409).send({ error: `Menu em uso pela rota de entrada "${inUse.name}"` });
    }

    await prisma.ivrMenu.delete({ where: { id: existing.id } });
    await fastify.audit({
      actorType: "TENANT_USER", actorId: sub, action: "tenant.ivr_menu.deleted",
      targetType: "IvrMenu", targetId: existing.id, ip: request.ip,
    });
    return reply.status(204).send();
  });
};
