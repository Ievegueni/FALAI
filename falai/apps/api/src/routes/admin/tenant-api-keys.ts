import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { generateApiKey, VALID_SCOPES } from "../../services/apiKey.service.js";
import { isValidCidr } from "../../services/ipAllowlist.js";

/**
 * Chaves de API de um cliente, vistas do lado do operador.
 *
 * Existe porque no produto API_BYOM o cliente não tem CRM: quem cria a chave,
 * define os scopes e fixa os IPs de origem somos nós. Para os outros produtos
 * é uma segunda via — o cliente continua a poder geri-las em /tenant/api-keys.
 */

const cidrList = z
  .array(z.string().trim().min(1))
  .max(50)
  .refine((list) => list.every(isValidCidr), { message: "Origem inválida (usa um IP ou CIDR)" });

const createSchema = z.object({
  label: z.string().min(2).max(100),
  scopes: z.array(z.enum(VALID_SCOPES)).min(1),
  allowedCidrs: cidrList.optional(),
});

const updateSchema = z
  .object({
    scopes: z.array(z.enum(VALID_SCOPES)).min(1).optional(),
    allowedCidrs: cidrList.optional(),
  })
  .refine((b) => b.scopes !== undefined || b.allowedCidrs !== undefined, {
    message: "Nada para actualizar",
  });

const KEY_FIELDS = {
  id: true, label: true, prefix: true, scopes: true, allowedCidrs: true,
  lastUsedAt: true, revokedAt: true, createdAt: true,
} as const;

export const adminTenantApiKeysRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/tenants/:id/api-keys
  fastify.get<{ Params: { id: string } }>("/:id/api-keys", { preHandler }, async (request, reply) => {
    const tenant = await prisma.tenant.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    const keys = await prisma.apiKey.findMany({
      where: { tenantId: tenant.id },
      select: KEY_FIELDS,
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    });

    return { data: keys, validScopes: VALID_SCOPES };
  });

  // POST /admin/tenants/:id/api-keys — a chave em claro só aparece nesta resposta
  fastify.post<{ Params: { id: string } }>("/:id/api-keys", { preHandler }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const admin = request.adminUser!;

    const tenant = await prisma.tenant.findFirst({
      where: { id: request.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    const { raw, hash, prefix } = generateApiKey();
    const allowedCidrs = [...new Set(body.allowedCidrs ?? [])];

    const apiKey = await prisma.apiKey.create({
      data: { tenantId: tenant.id, label: body.label, keyHash: hash, prefix, scopes: body.scopes, allowedCidrs },
      select: KEY_FIELDS,
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      tenantId: tenant.id,
      action: "api_key.created",
      targetType: "ApiKey",
      targetId: apiKey.id,
      after: { label: apiKey.label, scopes: apiKey.scopes, allowedCidrs: apiKey.allowedCidrs },
      ip: request.ip,
    });

    return reply.status(201).send({
      ...apiKey,
      key: raw,
      warning: "Guarda esta chave — não volta a ser mostrada.",
    });
  });

  // PATCH /admin/tenants/:id/api-keys/:keyId — scopes e origens
  fastify.patch<{ Params: { id: string; keyId: string } }>(
    "/:id/api-keys/:keyId",
    { preHandler },
    async (request, reply) => {
      const body = updateSchema.parse(request.body);
      const admin = request.adminUser!;

      const existing = await prisma.apiKey.findUnique({
        where: { id: request.params.keyId },
        select: { tenantId: true, revokedAt: true, scopes: true, allowedCidrs: true },
      });
      if (!existing || existing.tenantId !== request.params.id) {
        return reply.status(404).send({ error: "Chave não encontrada" });
      }
      if (existing.revokedAt) return reply.status(409).send({ error: "Chave já revogada" });

      const apiKey = await prisma.apiKey.update({
        where: { id: request.params.keyId },
        data: {
          ...(body.scopes !== undefined && { scopes: body.scopes }),
          ...(body.allowedCidrs !== undefined && { allowedCidrs: [...new Set(body.allowedCidrs)] }),
        },
        select: KEY_FIELDS,
      });

      await fastify.audit({
        actorType: "ADMIN",
        actorId: admin.sub,
        tenantId: existing.tenantId,
        action: "api_key.updated",
        targetType: "ApiKey",
        targetId: apiKey.id,
        before: { scopes: existing.scopes, allowedCidrs: existing.allowedCidrs },
        after: { scopes: apiKey.scopes, allowedCidrs: apiKey.allowedCidrs },
        ip: request.ip,
      });

      return apiKey;
    }
  );

  // DELETE /admin/tenants/:id/api-keys/:keyId — revoga (corte imediato, resolveApiKey deixa de a aceitar)
  fastify.delete<{ Params: { id: string; keyId: string } }>(
    "/:id/api-keys/:keyId",
    { preHandler },
    async (request, reply) => {
      const admin = request.adminUser!;

      const existing = await prisma.apiKey.findUnique({
        where: { id: request.params.keyId },
        select: { tenantId: true, revokedAt: true, label: true },
      });
      if (!existing || existing.tenantId !== request.params.id) {
        return reply.status(404).send({ error: "Chave não encontrada" });
      }
      if (existing.revokedAt) return reply.status(409).send({ error: "Chave já revogada" });

      await prisma.apiKey.update({
        where: { id: request.params.keyId },
        data: { revokedAt: new Date() },
      });

      await fastify.audit({
        actorType: "ADMIN",
        actorId: admin.sub,
        tenantId: existing.tenantId,
        action: "api_key.revoked",
        targetType: "ApiKey",
        targetId: request.params.keyId,
        before: { label: existing.label },
        ip: request.ip,
      });

      return reply.status(204).send();
    }
  );
};
