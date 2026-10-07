import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@falai/db";
import { isOpsManager } from "../../services/userScope.js";

/**
 * Chat interno da equipa: conversas directas (1:1) entre quaisquer colegas do
 * mesmo cliente e grupos criados pela supervisão/gestão. Só os membros vêem e
 * recebem (SSE `chat.message` entregue só a eles). VIEWER só lê (regra geral).
 */

export const directKey = (a: string, b: string) => [a, b].sort().join(":");
const canCreateGroups = (role: string) => isOpsManager(role) || role === "SUPERVISOR";

const groupSchema = z.object({ name: z.string().trim().min(1).max(80), memberIds: z.array(z.string()).min(1).max(500) });
const membersSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), memberIds: z.array(z.string()).min(1).max(500).optional() });
const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) });
const pageQuery = z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

export const tenantTeamChatRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  /** Membro da sala? (todas as rotas de uma sala passam por aqui) */
  const membership = (roomId: string, tenantId: string, userId: string) =>
    prisma.chatMember.findFirst({ where: { roomId, userId, room: { tenantId } }, include: { room: true } });

  /** Utilizadores do mesmo cliente, para não meter ids de fora numa sala. */
  const ownUsers = async (tenantId: string, ids: string[]) =>
    (await prisma.tenantUser.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } })).map((u) => u.id);

  // GET /tenant/chat/rooms — as minhas conversas, com a última mensagem e não lidas
  fastify.get("/tenant/chat/rooms", { preHandler }, async (request) => {
    const { tenantId, sub } = request.tenantUser!;
    const rooms = await prisma.chatRoom.findMany({
      where: { tenantId, members: { some: { userId: sub } } },
      orderBy: { lastMessageAt: "desc" },
      include: {
        members: { select: { userId: true, lastReadAt: true, user: { select: { name: true } } } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true, author: { select: { name: true } } } },
      },
    });
    const unread = await Promise.all(
      rooms.map((r) => {
        const me = r.members.find((m) => m.userId === sub)!;
        return prisma.chatMessage.count({ where: { roomId: r.id, createdAt: { gt: me.lastReadAt }, authorId: { not: sub } } });
      })
    );
    return {
      data: rooms.map((r, i) => ({
        id: r.id,
        kind: r.kind,
        // Directa: o nome é o do colega.
        name: r.kind === "DIRECT" ? (r.members.find((m) => m.userId !== sub)?.user.name ?? "—") : r.name,
        members: r.members.map((m) => ({ id: m.userId, name: m.user.name })),
        lastMessage: r.messages[0] ? { body: r.messages[0].body.slice(0, 120), at: r.messages[0].createdAt, author: r.messages[0].author.name } : null,
        lastMessageAt: r.lastMessageAt,
        unread: unread[i],
        canManage: r.kind === "GROUP" && (r.createdById === sub || isOpsManager(request.tenantUser!.role)),
      })),
      totalUnread: unread.reduce((a, b) => a + b, 0),
    };
  });

  // GET /tenant/chat/users — colegas para iniciar conversa (nome e papel)
  fastify.get("/tenant/chat/users", { preHandler }, async (request) => {
    const { tenantId, sub } = request.tenantUser!;
    return { data: await prisma.tenantUser.findMany({ where: { tenantId, id: { not: sub } }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }) };
  });

  // GET /tenant/chat/unread — só o total (menu)
  fastify.get("/tenant/chat/unread", { preHandler }, async (request) => {
    const { tenantId, sub } = request.tenantUser!;
    const mine = await prisma.chatMember.findMany({ where: { userId: sub, room: { tenantId } }, select: { roomId: true, lastReadAt: true } });
    const counts = await Promise.all(mine.map((m) => prisma.chatMessage.count({ where: { roomId: m.roomId, createdAt: { gt: m.lastReadAt }, authorId: { not: sub } } })));
    return { total: counts.reduce((a, b) => a + b, 0) };
  });

  // POST /tenant/chat/direct — abre (ou devolve) a conversa directa com um colega
  fastify.post("/tenant/chat/direct", { preHandler }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const { userId } = z.object({ userId: z.string() }).parse(request.body);
    if (userId === sub) return reply.status(400).send({ error: "Escolha outro colega" });
    if ((await ownUsers(tenantId, [userId])).length === 0) return reply.status(404).send({ error: "Utilizador não encontrado" });
    const key = directKey(sub, userId);
    const room =
      (await prisma.chatRoom.findUnique({ where: { tenantId_directKey: { tenantId, directKey: key } }, select: { id: true } })) ??
      (await prisma.chatRoom
        .create({ data: { tenantId, kind: "DIRECT", directKey: key, createdById: sub, members: { create: [{ userId: sub }, { userId }] } }, select: { id: true } })
        .catch(() => prisma.chatRoom.findUniqueOrThrow({ where: { tenantId_directKey: { tenantId, directKey: key } }, select: { id: true } }))); // corrida: o outro criou ao mesmo tempo
    return { id: room.id };
  });

  // POST /tenant/chat/rooms — grupo (supervisão/gestão)
  fastify.post("/tenant/chat/rooms", { preHandler }, async (request, reply) => {
    const { tenantId, sub, role } = request.tenantUser!;
    if (!canCreateGroups(role)) return reply.status(403).send({ error: "Só a supervisão cria grupos" });
    const body = groupSchema.parse(request.body);
    const members = await ownUsers(tenantId, [...new Set([sub, ...body.memberIds])]);
    const room = await prisma.chatRoom.create({
      data: { tenantId, kind: "GROUP", name: body.name, createdById: sub, members: { create: members.map((userId) => ({ userId })) } },
      select: { id: true },
    });
    return reply.status(201).send(room);
  });

  // PATCH /tenant/chat/rooms/:id — nome e membros do grupo (quem o criou ou gestão)
  fastify.patch<{ Params: { id: string } }>("/tenant/chat/rooms/:id", { preHandler }, async (request, reply) => {
    const { tenantId, sub, role } = request.tenantUser!;
    const room = await prisma.chatRoom.findFirst({ where: { id: request.params.id, tenantId, kind: "GROUP" } });
    if (!room) return reply.status(404).send({ error: "Grupo não encontrado" });
    if (room.createdById !== sub && !isOpsManager(role)) return reply.status(403).send({ error: "Só quem criou o grupo ou a gestão o altera" });
    const body = membersSchema.parse(request.body);
    if (body.name) await prisma.chatRoom.update({ where: { id: room.id }, data: { name: body.name } });
    if (body.memberIds) {
      const members = await ownUsers(tenantId, [...new Set([sub, ...body.memberIds])]);
      await prisma.$transaction([
        prisma.chatMember.deleteMany({ where: { roomId: room.id, userId: { notIn: members } } }),
        prisma.chatMember.createMany({ data: members.map((userId) => ({ roomId: room.id, userId })), skipDuplicates: true }),
      ]);
    }
    return { ok: true };
  });

  // DELETE /tenant/chat/rooms/:id/me — sair de um grupo
  fastify.delete<{ Params: { id: string } }>("/tenant/chat/rooms/:id/me", { preHandler }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const m = await membership(request.params.id, tenantId, sub);
    if (!m || m.room.kind !== "GROUP") return reply.status(404).send({ error: "Grupo não encontrado" });
    await prisma.chatMember.delete({ where: { roomId_userId: { roomId: m.roomId, userId: sub } } });
    return reply.status(204).send();
  });

  // GET /tenant/chat/rooms/:id/messages — mais recentes primeiro, paginado por data
  fastify.get<{ Params: { id: string } }>("/tenant/chat/rooms/:id/messages", { preHandler }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    if (!(await membership(request.params.id, tenantId, sub))) return reply.status(404).send({ error: "Conversa não encontrada" });
    const q = pageQuery.parse(request.query);
    const rows = await prisma.chatMessage.findMany({
      where: { roomId: request.params.id, ...(q.before && { createdAt: { lt: new Date(q.before) } }) },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      select: { id: true, body: true, createdAt: true, authorId: true, author: { select: { name: true } } },
    });
    return { data: rows.reverse(), hasMore: rows.length === q.limit };
  });

  // POST /tenant/chat/rooms/:id/messages — enviar
  fastify.post<{ Params: { id: string } }>("/tenant/chat/rooms/:id/messages", { preHandler }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const m = await membership(request.params.id, tenantId, sub);
    if (!m) return reply.status(404).send({ error: "Conversa não encontrada" });
    const { body } = messageSchema.parse(request.body);
    const now = new Date();
    const [msg] = await prisma.$transaction([
      prisma.chatMessage.create({ data: { roomId: m.roomId, authorId: sub, body }, select: { id: true, body: true, createdAt: true, authorId: true, author: { select: { name: true } } } }),
      prisma.chatRoom.update({ where: { id: m.roomId }, data: { lastMessageAt: now } }),
      prisma.chatMember.update({ where: { roomId_userId: { roomId: m.roomId, userId: sub } }, data: { lastReadAt: now } }),
    ]);
    const members = (await prisma.chatMember.findMany({ where: { roomId: m.roomId }, select: { userId: true } })).map((x) => x.userId);
    fastify.incomingCalls.sendToUsers(tenantId, members, "chat.message", { roomId: m.roomId, roomName: m.room.kind === "GROUP" ? m.room.name : null, message: msg });
    return reply.status(201).send(msg);
  });

  // POST /tenant/chat/rooms/:id/read — marcar como lida
  fastify.post<{ Params: { id: string } }>("/tenant/chat/rooms/:id/read", { preHandler }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const m = await membership(request.params.id, tenantId, sub);
    if (!m) return reply.status(404).send({ error: "Conversa não encontrada" });
    await prisma.chatMember.update({ where: { roomId_userId: { roomId: m.roomId, userId: sub } }, data: { lastReadAt: new Date() } });
    return reply.status(204).send();
  });
};
