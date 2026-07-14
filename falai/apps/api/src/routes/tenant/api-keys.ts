import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { generateApiKey, VALID_SCOPES } from "../../services/apiKey.service.js";

export async function tenantApiKeysRoutes(fastify: FastifyInstance): Promise<void> {
  // List API keys (shows prefix only, never the raw key)
  fastify.get("/tenant/api-keys", { preHandler: [fastify.verifyTenant] }, async (request, reply) => {
    const tenantId = request.tenantUser!.tenantId;
    const keys = await prisma.apiKey.findMany({
      where: { tenantId, revokedAt: null },
      select: {
        id: true, label: true, prefix: true, scopes: true,
        lastUsedAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return reply.send({ data: keys });
  });

  // Create API key — raw key returned once
  fastify.post("/tenant/api-keys", { preHandler: [fastify.verifyTenant] }, async (request, reply) => {
    const tenantId = request.tenantUser!.tenantId;
    const body = request.body as { label: string; scopes: string[] };

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

    const { raw, hash, prefix } = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: { tenantId, label: body.label, keyHash: hash, prefix, scopes: body.scopes },
      select: { id: true, label: true, prefix: true, scopes: true, createdAt: true },
    });

    return reply.status(201).send({ ...apiKey, key: raw, warning: "Save this key — it will not be shown again." });
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
    return reply.status(204).send();
  });
}
