import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { prisma, Prisma } from "@falai/db";
import { z } from "zod";
import { EXTENSION_DEFAULTS, generateSipCredentials, serializeExtension } from "../../services/sipProvisioning.service.js";
import { scheduleTenantPbxSync } from "../../services/pbxSync.service.js";
import type { RoutingCtx } from "./ivrRouting.js";

/**
 * Extensões de um tenant. Registadas duas vezes: no CRM (/tenant/extensions,
 * tenant do JWT) e no backoffice (/admin/tenants/:id/extensions). Antes o
 * backoffice só gravava TenantLine, que o CRM não mostra — o operador
 * configurava "linhas" e o cliente não via nada no perfil.
 */

// Blocos de config por aba — Json livre validado como objeto (a UI garante a forma).
const jsonObject = z.record(z.string(), z.unknown());

const createSchema = z.object({
  number: z.string().min(2).max(10).regex(/^\d+$/, "A extensão deve ser numérica"),
  callerId: z.string().min(1).max(64).optional(),
  displayName: z.string().max(120).optional(),
  email: z.string().email().optional().nullable(),
  mobile: z.string().max(32).optional().nullable(),
  roleId: z.string().cuid().optional().nullable(),
  phoneNumber: z.string().max(32).optional().nullable(),
});

const updateSchema = z.object({
  callerId: z.string().min(1).max(64).optional(),
  displayName: z.string().max(120).optional().nullable(),
  email: z.string().email().optional().nullable(),
  mobile: z.string().max(32).optional().nullable(),
  roleId: z.string().cuid().optional().nullable(),
  maxIpRegs: z.number().int().min(1).max(10).optional(),
  maxWebRegs: z.number().int().min(1).max(10).optional(),
  presence: jsonObject.optional(),
  voicemail: jsonObject.optional(),
  features: jsonObject.optional(),
  voip: jsonObject.optional(),
  security: jsonObject.optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  phoneNumber: z.string().max(32).optional().nullable(),
});

/**
 * @param base        prefixo dentro do plugin ("" no CRM, "/:id/extensions" no backoffice)
 * @param ctx         resolve tenant e actor; responde e devolve null se não pode.
 *                    `write` = pedido que altera dados (o CRM exige OWNER/ADMIN).
 * @param listConfig  config da rota de listagem (o CRM limita por feature)
 */
export function registerExtensions(
  fastify: FastifyInstance,
  opts: {
    base: string;
    preHandler: preHandlerHookHandler[];
    ctx: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<RoutingCtx | null>;
    listConfig?: Record<string, unknown>;
  }
): void {
  const { base, preHandler, ctx } = opts;
  const root = base || "/";
  type P = { Params: { id: string; extId: string } };

  function audit(c: RoutingCtx, request: FastifyRequest, action: string, targetId: string) {
    return fastify.audit({ actorType: c.actorType, actorId: c.actorId, tenantId: c.tenantId, action, targetType: "Extension", targetId, ip: request.ip });
  }

  async function assertRole(tenantId: string, roleId: string | null | undefined, reply: FastifyReply): Promise<boolean> {
    if (!roleId) return true;
    const roleOk = await prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!roleOk) reply.status(400).send({ error: "Função (role) inválida" });
    return !!roleOk;
  }

  // Lista
  fastify.get(root, { preHandler, ...(opts.listConfig && { config: opts.listConfig }) }, async (request, reply) => {
    const c = await ctx(request, reply, false);
    if (!c) return;
    const exts = await prisma.extension.findMany({ where: { tenantId: c.tenantId }, orderBy: { number: "asc" } });
    return exts.map(serializeExtension);
  });

  // Detalhe
  fastify.get<P>(`${base}/:extId`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, false);
    if (!c) return;
    const ext = await prisma.extension.findFirst({ where: { id: request.params.extId, tenantId: c.tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });
    return serializeExtension(ext);
  });

  // Criar (gera credenciais SIP, aplica defaults)
  fastify.post(root, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const body = createSchema.parse(request.body);

    const dup = await prisma.extension.findUnique({ where: { tenantId_number: { tenantId, number: body.number } } });
    if (dup) return reply.status(409).send({ error: `A extensão ${body.number} já existe` });
    if (!(await assertRole(tenantId, body.roleId, reply))) return;

    const creds = generateSipCredentials();
    const ext = await prisma.extension.create({
      data: {
        tenantId,
        number: body.number,
        callerId: body.callerId ?? body.number,
        displayName: body.displayName ?? body.number,
        email: body.email ?? null,
        mobile: body.mobile ?? null,
        roleId: body.roleId ?? null,
        phoneNumber: body.phoneNumber ?? null,
        sipAuthUser: creds.sipAuthUser,
        sipAuthSecret: creds.sipAuthSecretEncrypted,
        ...EXTENSION_DEFAULTS,
      },
    });

    await audit(c, request, "tenant.extension.created", ext.id);
    scheduleTenantPbxSync(tenantId);
    // Segredo em texto devolvido UMA vez (mostrar ao criar; nunca mais é exposto)
    return reply.status(201).send({ ...serializeExtension(ext), sipAuthSecret: creds.sipAuthSecretPlain });
  });

  // Editar (abas de config)
  fastify.put<P>(`${base}/:extId`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const { tenantId } = c;
    const body = updateSchema.parse(request.body);

    const ext = await prisma.extension.findFirst({ where: { id: request.params.extId, tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });
    if (!(await assertRole(tenantId, body.roleId, reply))) return;

    // Só uma extensão pode ser a por defeito
    if (body.isDefault === true) {
      await prisma.extension.updateMany({ where: { tenantId, isDefault: true, NOT: { id: ext.id } }, data: { isDefault: false } });
    }

    const updated = await prisma.extension.update({
      where: { id: ext.id },
      data: {
        ...(body.callerId !== undefined ? { callerId: body.callerId } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
        ...(body.mobile !== undefined ? { mobile: body.mobile } : {}),
        ...(body.roleId !== undefined ? { roleId: body.roleId } : {}),
        ...(body.maxIpRegs !== undefined ? { maxIpRegs: body.maxIpRegs } : {}),
        ...(body.maxWebRegs !== undefined ? { maxWebRegs: body.maxWebRegs } : {}),
        ...(body.presence !== undefined ? { presence: body.presence as Prisma.InputJsonValue } : {}),
        ...(body.voicemail !== undefined ? { voicemail: body.voicemail as Prisma.InputJsonValue } : {}),
        ...(body.features !== undefined ? { features: body.features as Prisma.InputJsonValue } : {}),
        ...(body.voip !== undefined ? { voip: body.voip as Prisma.InputJsonValue } : {}),
        ...(body.security !== undefined ? { security: body.security as Prisma.InputJsonValue } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.phoneNumber !== undefined ? { phoneNumber: body.phoneNumber } : {}),
      },
    });

    await audit(c, request, "tenant.extension.updated", ext.id);
    scheduleTenantPbxSync(tenantId);
    return serializeExtension(updated);
  });

  // Regenerar credenciais de registo
  fastify.post<P>(`${base}/:extId/reset-sip`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const ext = await prisma.extension.findFirst({ where: { id: request.params.extId, tenantId: c.tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });

    const creds = generateSipCredentials();
    const updated = await prisma.extension.update({
      where: { id: ext.id },
      data: { sipAuthUser: creds.sipAuthUser, sipAuthSecret: creds.sipAuthSecretEncrypted },
    });

    await audit(c, request, "tenant.extension.sip_reset", ext.id);
    scheduleTenantPbxSync(c.tenantId);
    return { ...serializeExtension(updated), sipAuthSecret: creds.sipAuthSecretPlain };
  });

  // Apagar
  fastify.delete<P>(`${base}/:extId`, { preHandler }, async (request, reply) => {
    const c = await ctx(request, reply, true);
    if (!c) return;
    const ext = await prisma.extension.findFirst({ where: { id: request.params.extId, tenantId: c.tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });

    await prisma.extension.delete({ where: { id: ext.id } });
    await audit(c, request, "tenant.extension.deleted", ext.id);
    scheduleTenantPbxSync(c.tenantId);
    return reply.status(204).send();
  });
}
