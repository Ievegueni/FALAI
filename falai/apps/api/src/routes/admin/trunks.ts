import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";
import { encryptSecret } from "../../services/crypto.service.js";
import { serializeTrunk, trunkCreateSchema, trunkUpdateSchema, trunkDataFromBody, validateTrunkAuth } from "../../services/trunk.service.js";
import { getAsteriskStatus } from "../../services/asteriskStatus.service.js";
import { scheduleAllPbxSync } from "../../services/pbxSync.service.js";

const didSchema = z.object({ did: z.string().min(3).max(32), name: z.string().max(64).optional().nullable() });

export const adminTrunksRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];
  const include = { dids: true } as const;

  // GET /admin/trunks/engine-status — estado do motor SIP próprio (Asterisk).
  // Responde ao pedido da ANGOVOIP de ver "registado / não registado".
  // Declarado antes de "/:id" para não ser apanhado por esse padrão.
  fastify.get("/engine-status", { preHandler }, async () => {
    return getAsteriskStatus();
  });

  // GET /admin/trunks — lista trunks partilhados (tenantId null) + BYO (para visão global)
  fastify.get("/", { preHandler }, async () => {
    const trunks = await prisma.trunk.findMany({ orderBy: [{ tenantId: "asc" }, { name: "asc" }], include });
    return { trunks: trunks.map(serializeTrunk) };
  });

  // GET /admin/trunks/:id
  fastify.get<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const trunk = await prisma.trunk.findUnique({ where: { id: request.params.id }, include });
    if (!trunk) return reply.status(404).send({ error: "Trunk não encontrado" });
    return { trunk: serializeTrunk(trunk) };
  });

  // POST /admin/trunks — trunk partilhado do operador (sem tenantId) ou
  // exclusivo de um cliente (com tenantId).
  //
  // O exclusivo é o que serve o produto API_BYOM: o cliente liga o PBX dele ao
  // nosso IP, sem registo, e passamos a saber de quem é cada chamada de entrada
  // pelo trunk por onde entrou. Esse cliente não tem CRM nosso, portanto é aqui
  // que se provisiona — a rota /tenant/trunks exige CRM_BYO_PBX.
  fastify.post("/", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const body = trunkCreateSchema.parse(request.body);
    // Num trunk PEER não há senha nenhuma — a autenticação é o endereço.
    const authProblem = validateTrunkAuth(body);
    if (authProblem) return reply.status(400).send({ error: authProblem });

    if (body.tenantId) {
      const tenant = await prisma.tenant.findFirst({
        where: { id: body.tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!tenant) return reply.status(400).send({ error: "Cliente não encontrado" });
    }

    const trunk = await prisma.trunk.create({
      data: {
        tenantId: body.tenantId ?? null,
        name: body.name,
        host: body.host,
        authUser: body.authUser,
        authSecret: body.authSecret ? encryptSecret(body.authSecret) : "",
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.itspTemplate !== undefined ? { itspTemplate: body.itspTemplate } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.transport !== undefined ? { transport: body.transport } : {}),
        ...(body.port !== undefined ? { port: body.port } : {}),
        ...(body.domain !== undefined ? { domain: body.domain } : {}),
        ...(body.authName !== undefined ? { authName: body.authName } : {}),
        ...(body.outboundProxy !== undefined ? { outboundProxy: body.outboundProxy } : {}),
        ...(body.codecs !== undefined ? { codecs: body.codecs } : {}),
        ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {}),
      },
      include,
    });

    await fastify.audit({ actorType: "ADMIN", actorId: admin.sub, action: "trunk.created", targetType: "Trunk", targetId: trunk.id, ip: request.ip });
    // O trunk partilhado afecta todos os clientes — sincroniza tudo.
    scheduleAllPbxSync();
    return reply.status(201).send({ trunk: serializeTrunk(trunk) });
  });

  // PUT /admin/trunks/:id
  fastify.put<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const body = trunkUpdateSchema.parse(request.body);

    const existing = await prisma.trunk.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Trunk não encontrado" });

    // Passar um trunk para PEER, ou mudar-lhe o host, muda a forma como ele se
    // autentica — tem de ser validado outra vez, não só na criação.
    const authProblem = validateTrunkAuth(body, existing);
    if (authProblem) return reply.status(400).send({ error: authProblem });

    const trunk = await prisma.trunk.update({
      where: { id: existing.id },
      data: trunkDataFromBody(body, encryptSecret),
      include,
    });

    await fastify.audit({ actorType: "ADMIN", actorId: admin.sub, action: "trunk.updated", targetType: "Trunk", targetId: trunk.id, ip: request.ip });
    scheduleAllPbxSync();
    return { trunk: serializeTrunk(trunk) };
  });

  // DELETE /admin/trunks/:id
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const existing = await prisma.trunk.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: "Trunk não encontrado" });

    const routes = await prisma.outboundRoute.count({ where: { trunkId: existing.id } });
    if (routes > 0) return reply.status(400).send({ error: "Há rotas a usar este trunk. Remove-as antes de o eliminar." });

    await prisma.trunk.delete({ where: { id: existing.id } });
    await fastify.audit({ actorType: "ADMIN", actorId: admin.sub, action: "trunk.deleted", targetType: "Trunk", targetId: existing.id, ip: request.ip });
    scheduleAllPbxSync();
    return reply.status(204).send();
  });

  // ── DIDs ────────────────────────────────────────────────────────────────
  // POST /admin/trunks/:id/dids
  fastify.post<{ Params: { id: string } }>("/:id/dids", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const body = didSchema.parse(request.body);
    const trunk = await prisma.trunk.findUnique({ where: { id: request.params.id } });
    if (!trunk) return reply.status(404).send({ error: "Trunk não encontrado" });

    const dup = await prisma.trunkDid.findUnique({ where: { trunkId_did: { trunkId: trunk.id, did: body.did } } });
    if (dup) return reply.status(409).send({ error: "Esse DID já existe neste trunk" });

    const did = await prisma.trunkDid.create({ data: { trunkId: trunk.id, did: body.did, name: body.name ?? null } });
    await fastify.audit({ actorType: "ADMIN", actorId: admin.sub, action: "trunk.did_added", targetType: "Trunk", targetId: trunk.id, ip: request.ip });
    return reply.status(201).send({ did: { id: did.id, did: did.did, name: did.name } });
  });

  // DELETE /admin/trunks/:id/dids/:didId
  fastify.delete<{ Params: { id: string; didId: string } }>("/:id/dids/:didId", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const did = await prisma.trunkDid.findFirst({ where: { id: request.params.didId, trunkId: request.params.id } });
    if (!did) return reply.status(404).send({ error: "DID não encontrado" });

    await prisma.trunkDid.delete({ where: { id: did.id } });
    await fastify.audit({ actorType: "ADMIN", actorId: admin.sub, action: "trunk.did_removed", targetType: "Trunk", targetId: request.params.id, ip: request.ip });
    return reply.status(204).send();
  });
};
