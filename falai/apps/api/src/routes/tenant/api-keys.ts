import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { generateApiKey, VALID_SCOPES } from "../../services/apiKey.service.js";
import { isValidCidr } from "../../services/ipAllowlist.js";

/**
 * Valida a lista de origens permitidas de uma chave. Devolve a lista limpa ou
 * as entradas inválidas — recusamos na escrita para não haver chaves com uma
 * allowlist que nunca casa (o que seria um corte de serviço silencioso).
 */
function parseAllowedCidrs(input: unknown): { ok: true; value: string[] } | { ok: false; invalid: string[] } {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, invalid: ["(não é uma lista)"] };

  const entries = input.map((e) => String(e).trim()).filter((e) => e !== "");
  const invalid = entries.filter((e) => !isValidCidr(e));
  if (invalid.length > 0) return { ok: false, invalid };

  return { ok: true, value: [...new Set(entries)] };
}

export async function tenantApiKeysRoutes(fastify: FastifyInstance): Promise<void> {
  // List API keys (shows prefix only, never the raw key)
  fastify.get("/tenant/api-keys", { preHandler: [fastify.verifyTenant] }, async (request, reply) => {
    const tenantId = request.tenantUser!.tenantId;
    const keys = await prisma.apiKey.findMany({
      where: { tenantId, revokedAt: null },
      select: {
        id: true, label: true, prefix: true, scopes: true, allowedCidrs: true,
        lastUsedAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return reply.send({ data: keys });
  });

  // Create API key — raw key returned once
  fastify.post("/tenant/api-keys", { preHandler: [fastify.verifyTenant] }, async (request, reply) => {
    const tenantId = request.tenantUser!.tenantId;
    const body = request.body as { label: string; scopes: string[]; allowedCidrs?: string[] };

    if (!body.label || typeof body.label !== "string") {
      return reply.status(400).send({ error: "label is required" });
    }
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return reply.status(400).send({ error: "scopes must be a non-empty array" });
    }
    const invalidScopes = body.scopes.filter((s) => !(VALID_SCOPES as readonly string[]).includes(s));
    if (invalidScopes.length > 0) {
      return reply.status(400).send({ error: "Invalid scopes", invalid: invalidScopes, valid: VALID_SCOPES });
    }

    const cidrs = parseAllowedCidrs(body.allowedCidrs);
    if (!cidrs.ok) {
      return reply.status(400).send({ error: "Invalid allowedCidrs", invalid: cidrs.invalid });
    }

    const { raw, hash, prefix } = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: { tenantId, label: body.label, keyHash: hash, prefix, scopes: body.scopes, allowedCidrs: cidrs.value },
      select: { id: true, label: true, prefix: true, scopes: true, allowedCidrs: true, createdAt: true },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      tenantId,
      action: "api_key.created",
      targetType: "ApiKey",
      targetId: apiKey.id,
      after: { label: apiKey.label, scopes: apiKey.scopes, allowedCidrs: apiKey.allowedCidrs },
      ip: request.ip,
    });

    return reply.status(201).send({ ...apiKey, key: raw, warning: "Save this key — it will not be shown again." });
  });

  // Update scopes / allowed origins of an existing key (the key itself never changes)
  fastify.patch("/tenant/api-keys/:id", { preHandler: [fastify.verifyTenant] }, async (request, reply) => {
    const tenantId = request.tenantUser!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as { scopes?: string[]; allowedCidrs?: string[] };

    const existing = await prisma.apiKey.findUnique({
      where: { id },
      select: { tenantId: true, revokedAt: true, scopes: true, allowedCidrs: true },
    });
    if (!existing || existing.tenantId !== tenantId) {
      return reply.status(404).send({ error: "API key not found" });
    }
    if (existing.revokedAt) {
      return reply.status(409).send({ error: "API key is revoked" });
    }

    const data: { scopes?: string[]; allowedCidrs?: string[] } = {};

    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
        return reply.status(400).send({ error: "scopes must be a non-empty array" });
      }
      const invalidScopes = body.scopes.filter((s) => !(VALID_SCOPES as readonly string[]).includes(s));
      if (invalidScopes.length > 0) {
        return reply.status(400).send({ error: "Invalid scopes", invalid: invalidScopes, valid: VALID_SCOPES });
      }
      data.scopes = body.scopes;
    }

    if (body.allowedCidrs !== undefined) {
      const cidrs = parseAllowedCidrs(body.allowedCidrs);
      if (!cidrs.ok) {
        return reply.status(400).send({ error: "Invalid allowedCidrs", invalid: cidrs.invalid });
      }
      data.allowedCidrs = cidrs.value;
    }

    if (Object.keys(data).length === 0) {
      return reply.status(400).send({ error: "Nothing to update" });
    }

    const apiKey = await prisma.apiKey.update({
      where: { id },
      data,
      select: { id: true, label: true, prefix: true, scopes: true, allowedCidrs: true, createdAt: true },
    });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      tenantId,
      action: "api_key.updated",
      targetType: "ApiKey",
      targetId: apiKey.id,
      before: { scopes: existing.scopes, allowedCidrs: existing.allowedCidrs },
      after: { scopes: apiKey.scopes, allowedCidrs: apiKey.allowedCidrs },
      ip: request.ip,
    });

    return reply.send(apiKey);
  });

  // Revoke API key
  fastify.delete("/tenant/api-keys/:id", { preHandler: [fastify.verifyTenant] }, async (request, reply) => {
    const tenantId = request.tenantUser!.tenantId;
    const { id } = request.params as { id: string };

    const apiKey = await prisma.apiKey.findUnique({ where: { id }, select: { tenantId: true, revokedAt: true } });
    if (!apiKey || apiKey.tenantId !== tenantId) {
      return reply.status(404).send({ error: "API key not found" });
    }
    if (apiKey.revokedAt) {
      return reply.status(409).send({ error: "API key already revoked" });
    }

    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: request.tenantUser!.sub,
      tenantId,
      action: "api_key.revoked",
      targetType: "ApiKey",
      targetId: id,
      ip: request.ip,
    });

    return reply.status(204).send();
  });
}
