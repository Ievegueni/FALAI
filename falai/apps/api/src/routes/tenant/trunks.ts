import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { encryptSecret } from "../../services/crypto.service.js";
import { serializeTrunk, trunkCreateSchema, trunkUpdateSchema, trunkDataFromBody } from "../../services/trunk.service.js";
import { scheduleTenantPbxSync } from "../../services/pbxSync.service.js";

/**
 * Trunks vistos pelo tenant. Regra (docs/sip_trunk.md §1.1/§3):
 *  - trunk partilhado (tenantId null) → só-leitura no CRM (editável no backoffice);
 *  - trunk BYO (tenantId = tenant, produto CRM_BYO_PBX) → editável pelo cliente.
 */
export const tenantTrunksRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];
  const include = { dids: true } as const;

  async function productType(tenantId: string): Promise<string> {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: { select: { productType: true } } } });
    return t.plan.productType;
  }

  function requireManager(role: string, reply: import("fastify").FastifyReply): boolean {
    if (role !== "OWNER" && role !== "ADMIN") {
      reply.status(403).send({ error: "Apenas OWNER ou ADMIN podem gerir o trunk" });
      return false;
    }
    return true;
  }

  // GET /tenant/trunks — partilhados (só-leitura) + BYO próprios; marca `editable`
  fastify.get("/", { preHandler }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const product = await productType(tenantId);
    const trunks = await prisma.trunk.findMany({
      where: { OR: [{ tenantId: null }, { tenantId }] },
      orderBy: [{ tenantId: "asc" }, { name: "asc" }],
      include,
    });
    return {
      productType: product,
      trunks: trunks.map((t) => ({
        ...serializeTrunk(t),
        editable: t.tenantId === tenantId && product === "CRM_BYO_PBX",
      })),
    };
  });

  // POST /tenant/trunks — só BYO
  fastify.post("/", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;
    if ((await productType(tenantId)) !== "CRM_BYO_PBX") {
      return reply.status(403).send({ error: "O plano actual não permite gerir o trunk (é gerido pelo operador)" });
    }
    const body = trunkCreateSchema.parse(request.body);
    if (!body.authSecret) return reply.status(400).send({ error: "Indique o segredo (palavra-passe) do trunk" });

    const trunk = await prisma.trunk.create({
      data: {
        tenantId,
        name: body.name,
        host: body.host,
        authUser: body.authUser,
        authSecret: encryptSecret(body.authSecret),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.transport !== undefined ? { transport: body.transport } : {}),
        ...(body.port !== undefined ? { port: body.port } : {}),
        ...(body.domain !== undefined ? { domain: body.domain } : {}),
        ...(body.authName !== undefined ? { authName: body.authName } : {}),
        ...(body.codecs !== undefined ? { codecs: body.codecs } : {}),
      },
      include,
    });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.trunk.created", targetType: "Trunk", targetId: trunk.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return reply.status(201).send({ trunk: serializeTrunk(trunk) });
  });

  // PUT /tenant/trunks/:id — só o próprio trunk BYO
  fastify.put<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const existing = await prisma.trunk.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Trunk não encontrado" });
    if (existing.tenantId !== tenantId || (await productType(tenantId)) !== "CRM_BYO_PBX") {
      return reply.status(403).send({ error: "Este trunk é gerido pelo operador e não pode ser editado aqui" });
    }

    const body = trunkUpdateSchema.parse(request.body);
    const trunk = await prisma.trunk.update({ where: { id: existing.id }, data: trunkDataFromBody(body, encryptSecret), include });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.trunk.updated", targetType: "Trunk", targetId: trunk.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return { trunk: serializeTrunk(trunk) };
  });

  // DELETE /tenant/trunks/:id — só o próprio trunk BYO
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!requireManager(role, reply)) return;

    const existing = await prisma.trunk.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Trunk não encontrado" });
    if (existing.tenantId !== tenantId) {
      return reply.status(403).send({ error: "Este trunk é gerido pelo operador e não pode ser eliminado aqui" });
    }
    const routes = await prisma.outboundRoute.count({ where: { trunkId: existing.id } });
    if (routes > 0) return reply.status(400).send({ error: "Há rotas a usar este trunk. Remove-as antes de o eliminar." });

    await prisma.trunk.delete({ where: { id: existing.id } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, action: "tenant.trunk.deleted", targetType: "Trunk", targetId: existing.id, ip: request.ip });
    scheduleTenantPbxSync(tenantId);
    return reply.status(204).send();
  });
};
