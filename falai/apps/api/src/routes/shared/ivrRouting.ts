import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { scheduleTenantPbxSync } from "../../services/pbxSync.service.js";
import { sharedTrunkDidProblem } from "../../services/callRouting.service.js";

/**
 * Rotas de entrada (DID → destino) e menus IVR de um tenant. Registadas duas
 * vezes: no CRM (/tenant/routing, tenant do JWT) e no backoffice
 * (/admin/tenants/:id, o operador configura sem entrar no perfil do cliente).
 * Mesma validação nos dois lados — o que muda é só de onde vem o tenant.
 */

export interface RoutingCtx {
  tenantId: string;
  actorType: "TENANT_USER" | "ADMIN";
  actorId: string;
}

const inboundCreate = z.object({
  name: z.string().min(2).max(64),
  trunkId: z.string().cuid(),
  didPattern: z.string().min(1).max(64),
  destType: z.enum(["EXTENSION", "GROUP", "IVR", "AI_AGENT"]),
  destValue: z.string().min(1).max(128),
});
const inboundUpdate = inboundCreate.partial();

const ivrOption = z.object({
  digit: z.string().regex(/^[0-9*#]$/),
  destType: z.enum(["EXTENSION", "GROUP", "IVR"]),
  destValue: z.string().min(1).max(128),
});
const ivrCreate = z.object({
  name: z.string().min(2).max(64),
  // Vazio só faz sentido com áudio carregado (POST .../audio a seguir ao create).
  greeting: z.string().max(1000).default(""),
  options: z.array(ivrOption).max(12).refine((o) => new Set(o.map((x) => x.digit)).size === o.length, "Dígito repetido"),
  timeoutSecs: z.number().int().min(2).max(30).default(6),
  maxRetries: z.number().int().min(0).max(5).default(2),
});
const ivrUpdate = ivrCreate.partial();
/** Tira os campos ausentes (exactOptionalPropertyTypes não deixa passar `undefined` ao Prisma). */
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]-?: Exclude<T[K], undefined> };

// Valida que o trunk é utilizável pelo tenant (partilhado ou próprio)
/** Rotas só podem usar trunks associados ao tenant — os mesmos que ele vê no CRM. */
export async function assertTrunk(tenantId: string, trunkId: string): Promise<boolean> {
  const trunk = await prisma.trunk.findFirst({ where: { id: trunkId, tenantId } });
  return !!trunk;
}

/**
 * Um DID encaminhado para "IVR" tem no destValue o id de um menu. Sem esta
 * verificação era possível apontar um número para um menu inexistente (ou de
 * outro cliente) e só dar por isso com um chamador a ouvir "sem serviço".
 */
async function assertDestination(tenantId: string, destType: string, destValue: string): Promise<boolean> {
  if (destType !== "IVR") return true;
  const menu = await prisma.ivrMenu.findFirst({ where: { id: destValue, tenantId }, select: { id: true } });
  return !!menu;
}

/**
 * @param base   prefixo dentro do plugin ("" no CRM, "/:id" no backoffice)
 * @param ctx    resolve tenant e actor; responde e devolve null se não pode.
 *               `write` = pedido que altera dados (o CRM exige OWNER/ADMIN).
 */
export function registerIvrRouting(
  fastify: FastifyInstance,
  opts: {
    base: string;
    preHandler: preHandlerHookHandler[];
    ctx: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<RoutingCtx | null>;
  }
): void {
  const { base, preHandler, ctx } = opts;
  type P = { Params: { id: string; itemId: string } };

  // Opções para os selectores de destino (o backoffice não tem as listas do CRM).
  fastify.get(`${base}/routing-options`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, false);
    if (!c) return;
    const [extensions, groups, trunks] = await Promise.all([
      prisma.extension.findMany({ where: { tenantId: c.tenantId }, orderBy: { number: "asc" }, select: { number: true, displayName: true } }),
      prisma.extensionGroup.findMany({ where: { tenantId: c.tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.trunk.findMany({ where: { OR: [{ tenantId: c.tenantId }, { tenantId: null }] }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    return { extensions, groups, trunks };
  });

  // ── Rotas de entrada ───────────────────────────────────────────────────────
  fastify.get(`${base}/inbound-routes`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, false);
    if (!c) return;
    const { tenantId } = c;
    const routes = await prisma.inboundRoute.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, include: { trunk: { select: { name: true } } } });
    return routes.map((r) => ({ id: r.id, name: r.name, trunkId: r.trunkId, trunkName: r.trunk.name, didPattern: r.didPattern, destType: r.destType, destValue: r.destValue }));
  });

  fastify.post<P>(`${base}/inbound-routes`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const body = inboundCreate.parse(request.body);
    if (!(await assertTrunk(tenantId, body.trunkId))) return reply.status(400).send({ error: "Trunk inválido" });
    if (!(await assertDestination(tenantId, body.destType, body.destValue))) {
      return reply.status(400).send({ error: "Menu de IVR inexistente" });
    }
    const didProblem = await sharedTrunkDidProblem(tenantId, body.trunkId, body.didPattern);
    if (didProblem) return reply.status(400).send({ error: didProblem });

    const route = await prisma.inboundRoute.create({
      data: { tenantId, name: body.name, trunkId: body.trunkId, didPattern: body.didPattern, destType: body.destType, destValue: body.destValue },
    });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.inbound_route.created", targetType: "InboundRoute", targetId: route.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return reply.status(201).send({ id: route.id });
  });

  fastify.put<P>(`${base}/inbound-routes/:itemId`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const body = inboundUpdate.parse(request.body);

    const existing = await prisma.inboundRoute.findFirst({ where: { id: request.params.itemId, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Rota não encontrada" });
    if (body.trunkId && !(await assertTrunk(tenantId, body.trunkId))) return reply.status(400).send({ error: "Trunk inválido" });

    // Qualquer um dos dois campos pode vir sozinho: valida-se o par que a rota
    // vai ficar a ter, não só o que mudou.
    const destType = body.destType ?? existing.destType;
    const destValue = body.destValue ?? existing.destValue;
    if (!(await assertDestination(tenantId, destType, destValue))) {
      return reply.status(400).send({ error: "Menu de IVR inexistente" });
    }
    // Mesmo raciocínio: valida-se o par trunk/número com que a rota fica.
    const didProblem = await sharedTrunkDidProblem(
      tenantId, body.trunkId ?? existing.trunkId, body.didPattern ?? existing.didPattern, existing.id,
    );
    if (didProblem) return reply.status(400).send({ error: didProblem });

    await prisma.inboundRoute.update({
      where: { id: existing.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.trunkId !== undefined ? { trunkId: body.trunkId } : {}),
        ...(body.didPattern !== undefined ? { didPattern: body.didPattern } : {}),
        ...(body.destType !== undefined ? { destType: body.destType } : {}),
        ...(body.destValue !== undefined ? { destValue: body.destValue } : {}),
      },
    });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.inbound_route.updated", targetType: "InboundRoute", targetId: existing.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return { ok: true };
  });

  fastify.delete<P>(`${base}/inbound-routes/:itemId`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const existing = await prisma.inboundRoute.findFirst({ where: { id: request.params.itemId, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Rota não encontrada" });
    await prisma.inboundRoute.delete({ where: { id: existing.id } });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.inbound_route.deleted", targetType: "InboundRoute", targetId: existing.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return reply.status(204).send();
  });

  // ── Menus IVR ──────────────────────────────────────────────────────────────
  // Destinos das opções têm de ser do próprio tenant (o runtime volta a filtrar
  // por tenant, mas assim o erro aparece ao gravar e não a meio de uma chamada).
  async function invalidIvrOption(tenantId: string, options: z.infer<typeof ivrOption>[]): Promise<string | null> {
    for (const o of options) {
      const found =
        o.destType === "EXTENSION" ? await prisma.extension.findFirst({ where: { tenantId, number: o.destValue }, select: { id: true } })
        : o.destType === "GROUP" ? await prisma.extensionGroup.findFirst({ where: { tenantId, id: o.destValue }, select: { id: true } })
        : await prisma.ivrMenu.findFirst({ where: { tenantId, id: o.destValue }, select: { id: true } });
      if (!found) return `Destino inválido na opção ${o.digit}`;
    }
    return null;
  }

  /**
   * O Asterisk toca .wav só em PCM 16-bit 8 kHz mono; o browser converte o
   * ficheiro do cliente (mp3, m4a, wav…) para isto antes de enviar. Cabeçalho
   * canónico de 44 bytes, que é o que o conversor do CRM/backoffice escreve.
   */
  function isTelephonyWav(b: Buffer): boolean {
    return b.length > 44 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE"
      && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1 && b.readUInt32LE(24) === 8000 && b.readUInt16LE(34) === 16;
  }

  // Gera a saudação por TTS. Uma falha não desfaz o menu gravado: devolve-se o
  // erro para o cliente voltar a gravar.
  async function synthGreeting(menuId: string, greeting: string): Promise<string | null> {
    if (greeting.trim().length < 2) return null; // sem texto: o áudio vem por upload
    try {
      await fastify.callEngine.audioCache.prepareIvrPrompt(menuId, greeting);
      return null;
    } catch (err) {
      fastify.log.error({ err, menuId }, "ivr.greeting_tts_failed");
      return "Menu gravado, mas falhou a geração do áudio da saudação — tente gravar de novo";
    }
  }

  fastify.get(`${base}/ivr`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, false);
    if (!c) return;
    const { tenantId } = c;
    return prisma.ivrMenu.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, greeting: true, greetingAudio: true, options: true, timeoutSecs: true, maxRetries: true },
    });
  });

  fastify.post<P>(`${base}/ivr`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const body = ivrCreate.parse(request.body);
    const bad = await invalidIvrOption(tenantId, body.options);
    if (bad) return reply.status(400).send({ error: bad });
    const dup = await prisma.ivrMenu.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (dup) return reply.status(409).send({ error: "Já existe um menu com esse nome" });

    const menu = await prisma.ivrMenu.create({ data: { tenantId, ...body } });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.ivr.created", targetType: "IvrMenu", targetId: menu.id, ip: request.ip });
    const ttsError = await synthGreeting(menu.id, menu.greeting);
    if (ttsError) return reply.status(502).send({ error: ttsError, id: menu.id });
    return reply.status(201).send({ id: menu.id });
  });

  fastify.put<P>(`${base}/ivr/:itemId`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const body = ivrUpdate.parse(request.body);
    const existing = await prisma.ivrMenu.findFirst({ where: { id: request.params.itemId, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Menu não encontrado" });
    if (body.options) {
      const bad = await invalidIvrOption(tenantId, body.options);
      if (bad) return reply.status(400).send({ error: bad });
    }

    const menu = await prisma.ivrMenu.update({ where: { id: existing.id }, data: defined(body) });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.ivr.updated", targetType: "IvrMenu", targetId: menu.id, ip: request.ip });
    // Regera sempre (repõe o áudio se a gravação anterior falhou), excepto se o
    // cliente carregou um ficheiro — esse só sai com DELETE .../audio.
    const ttsError = menu.greetingAudio ? null : await synthGreeting(menu.id, menu.greeting);
    if (ttsError) return reply.status(502).send({ error: ttsError, id: menu.id });
    return { ok: true };
  });

  fastify.post<P>(`${base}/ivr/:itemId/audio`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const existing = await prisma.ivrMenu.findFirst({ where: { id: request.params.itemId, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Menu não encontrado" });
    const file = request.isMultipart() ? await request.file() : undefined;
    if (!file) return reply.status(400).send({ error: "Envie o áudio num campo 'file' (multipart)" });
    const wav = await file.toBuffer();
    if (!isTelephonyWav(wav)) return reply.status(400).send({ error: "Áudio tem de ser WAV PCM 16-bit, 8 kHz, mono" });

    await fastify.callEngine.audioCache.uploadIvrPrompt(existing.id, wav);
    await prisma.ivrMenu.update({ where: { id: existing.id }, data: { greetingAudio: true } });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.ivr.audio_uploaded", targetType: "IvrMenu", targetId: existing.id, ip: request.ip });
    return { ok: true };
  });

  // Volta à saudação por TTS a partir do texto do menu.
  fastify.delete<P>(`${base}/ivr/:itemId/audio`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const existing = await prisma.ivrMenu.findFirst({ where: { id: request.params.itemId, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Menu não encontrado" });
    if (existing.greeting.trim().length < 2) return reply.status(400).send({ error: "Escreva o texto da saudação antes de remover o áudio" });

    await prisma.ivrMenu.update({ where: { id: existing.id }, data: { greetingAudio: false } });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.ivr.audio_removed", targetType: "IvrMenu", targetId: existing.id, ip: request.ip });
    const ttsError = await synthGreeting(existing.id, existing.greeting);
    if (ttsError) return reply.status(502).send({ error: ttsError });
    return reply.status(204).send();
  });

  fastify.delete<P>(`${base}/ivr/:itemId`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const existing = await prisma.ivrMenu.findFirst({ where: { id: request.params.itemId, tenantId } });
    if (!existing) return reply.status(404).send({ error: "Menu não encontrado" });
    const inUse = await prisma.inboundRoute.count({ where: { tenantId, destType: "IVR", destValue: existing.id } });
    if (inUse) return reply.status(409).send({ error: "Menu em uso numa rota de entrada" });
    const parent = await prisma.ivrMenu.findFirst({
      where: { tenantId, options: { array_contains: [{ destType: "IVR", destValue: existing.id }] } },
      select: { name: true },
    });
    if (parent) return reply.status(409).send({ error: `Menu em uso no menu ${parent.name}` });
    await prisma.ivrMenu.delete({ where: { id: existing.id } });
    await fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId, action: "tenant.ivr.deleted", targetType: "IvrMenu", targetId: existing.id, ip: request.ip });
    return reply.status(204).send();
  });
}
