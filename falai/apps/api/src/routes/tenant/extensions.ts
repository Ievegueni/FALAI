import type { FastifyPluginAsync } from "fastify";
import { prisma, Prisma } from "@falai/db";
import { z } from "zod";
import { EXTENSION_DEFAULTS, generateSipCredentials, serializeExtension } from "../../services/sipProvisioning.service.js";
import { scheduleTenantPbxSync } from "../../services/pbxSync.service.js";

// Blocos de config por aba — Json livre validado como objeto (a UI garante a forma).
const jsonObject = z.record(z.string(), z.unknown());

const createSchema = z.object({
  number: z.string().min(2).max(10).regex(/^\d+$/, "A extensão deve ser numérica"),
  callerId: z.string().min(1).max(64).optional(),
  displayName: z.string().max(120).optional(),
  email: z.string().email().optional().nullable(),
  mobile: z.string().max(32).optional().nullable(),
  roleId: z.string().cuid().optional().nullable(),
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

export const tenantExtensionsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  function requireManager(role: string, reply: import("fastify").FastifyReply): boolean {
    if (role !== "OWNER" && role !== "ADMIN") {
      reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir extensões" });
      return false;
    }
    return true;
  }

  // GET /tenant/extensions — lista
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const exts = await prisma.extension.findMany({ where: { tenantId }, orderBy: { number: "asc" } });
    return exts.map(serializeExtension);
  });

  // GET /tenant/extensions/:id — detalhe
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const ext = await prisma.extension.findFirst({ where: { id: request.params.id, tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });
    return serializeExtension(ext);
  });

  // POST /tenant/extensions — criar (gera credenciais SIP, aplica defaults)
  fastify.post("/", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = createSchema.parse(request.body);

    const dup = await prisma.extension.findUnique({ where: { tenantId_number: { tenantId, number: body.number } } });
    if (dup) return reply.status(409).send({ error: `A extensão ${body.number} já existe` });

    if (body.roleId) {
      const roleOk = await prisma.role.findFirst({ where: { id: body.roleId, tenantId } });
      if (!roleOk) return reply.status(400).send({ error: "Função (role) inválida" });
    }

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
        sipAuthUser: creds.sipAuthUser,
        sipAuthSecret: creds.sipAuthSecretEncrypted,
        ...EXTENSION_DEFAULTS,
      },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: sub,
      action: "tenant.extension.created",
      targetType: "Extension",
      targetId: ext.id,
      ip: request.ip,
    });

    scheduleTenantPbxSync(tenantId);
    // Segredo em texto devolvido UMA vez (mostrar ao criar; nunca mais é exposto)
    return reply.status(201).send({ ...serializeExtension(ext), sipAuthSecret: creds.sipAuthSecretPlain });
  });

  // PUT /tenant/extensions/:id — editar (abas de config)
  fastify.put<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    const body = updateSchema.parse(request.body);

    const ext = await prisma.extension.findFirst({ where: { id: request.params.id, tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });

    if (body.roleId) {
      const roleOk = await prisma.role.findFirst({ where: { id: body.roleId, tenantId } });
      if (!roleOk) return reply.status(400).send({ error: "Função (role) inválida" });
    }

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

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: sub,
      action: "tenant.extension.updated",
      targetType: "Extension",
      targetId: ext.id,
      ip: request.ip,
    });

    scheduleTenantPbxSync(tenantId);
    return serializeExtension(updated);
  });

  // POST /tenant/extensions/:id/reset-sip — regenerar credenciais de registo
  fastify.post<{ Params: { id: string } }>("/:id/reset-sip", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const ext = await prisma.extension.findFirst({ where: { id: request.params.id, tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });

    const creds = generateSipCredentials();
    const updated = await prisma.extension.update({
      where: { id: ext.id },
      data: { sipAuthUser: creds.sipAuthUser, sipAuthSecret: creds.sipAuthSecretEncrypted },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: sub,
      action: "tenant.extension.sip_reset",
      targetType: "Extension",
      targetId: ext.id,
      ip: request.ip,
    });

    scheduleTenantPbxSync(tenantId);
    return { ...serializeExtension(updated), sipAuthSecret: creds.sipAuthSecretPlain };
  });

  // DELETE /tenant/extensions/:id
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const ext = await prisma.extension.findFirst({ where: { id: request.params.id, tenantId } });
    if (!ext) return reply.status(404).send({ error: "Extensão não encontrada" });

    await prisma.extension.delete({ where: { id: ext.id } });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: sub,
      action: "tenant.extension.deleted",
      targetType: "Extension",
      targetId: ext.id,
      ip: request.ip,
    });

    scheduleTenantPbxSync(tenantId);
    return reply.status(204).send();
  });
};
