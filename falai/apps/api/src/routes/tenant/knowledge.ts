import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@falai/db";
import { keywords, pickArticles } from "../../services/knowledge.service.js";
import { isOpsManager } from "../../services/userScope.js";

/**
 * Base de conhecimento (fase 10) — ver services/knowledge.service.ts.
 * Ler: todos (o agente consulta). Escrever: gestor/admin e supervisor.
 * Os rascunhos (não publicados) só os vê quem escreve.
 */

const canWrite = (role: string) => isOpsManager(role) || role === "SUPERVISOR";

const articleSchema = z.object({
  title: z.string().trim().min(2).max(200),
  body: z.string().trim().min(1).max(50_000),
  category: z.string().trim().max(80).nullable().optional(),
  isPublished: z.boolean().optional(),
  aiEnabled: z.boolean().optional(),
});
const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const summary = { id: true, title: true, category: true, isPublished: true, aiEnabled: true, updatedAt: true } satisfies Prisma.KbArticleSelect;

export const tenantKnowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // GET /tenant/kb — lista ou pesquisa (?q=), com um excerto do texto
  fastify.get("/tenant/kb", { preHandler }, async (request) => {
    const { tenantId, role } = request.tenantUser!;
    const q = listQuery.parse(request.query);
    const words = q.q ? keywords(q.q) : [];
    const where: Prisma.KbArticleWhereInput = {
      tenantId,
      ...(!canWrite(role) && { isPublished: true }),
      ...(q.category && { category: q.category }),
      ...(words.length && {
        OR: words.flatMap((w) => [{ title: { contains: w, mode: "insensitive" as const } }, { body: { contains: w, mode: "insensitive" as const } }]),
      }),
    };
    const rows = await prisma.kbArticle.findMany({ where, orderBy: { updatedAt: "desc" }, take: words.length ? 300 : q.limit, select: { ...summary, body: true } });
    const ranked = words.length ? pickArticles(q.q!, rows, q.limit) : rows;
    const categories = await prisma.kbArticle.findMany({ where: { tenantId, category: { not: null } }, distinct: ["category"], select: { category: true } });
    return {
      data: ranked.map(({ body, ...a }) => ({ ...a, excerpt: body.slice(0, 220) })),
      categories: categories.map((c) => c.category!).sort(),
    };
  });

  fastify.get<{ Params: { id: string } }>("/tenant/kb/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    const a = await prisma.kbArticle.findFirst({ where: { id: request.params.id, tenantId, ...(!canWrite(role) && { isPublished: true }) } });
    if (!a) return reply.status(404).send({ error: "Artigo não encontrado" });
    return { ...a, canEdit: canWrite(role) };
  });

  fastify.post("/tenant/kb", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!canWrite(role)) return reply.status(403).send({ error: "Só supervisão edita a base de conhecimento" });
    const b = articleSchema.parse(request.body);
    const a = await prisma.kbArticle.create({
      data: {
        tenantId,
        title: b.title,
        body: b.body,
        category: b.category ?? null,
        ...(b.isPublished !== undefined && { isPublished: b.isPublished }),
        ...(b.aiEnabled !== undefined && { aiEnabled: b.aiEnabled }),
        createdById: sub,
        updatedById: sub,
      },
    });
    return reply.status(201).send(a);
  });

  fastify.put<{ Params: { id: string } }>("/tenant/kb/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!canWrite(role)) return reply.status(403).send({ error: "Só supervisão edita a base de conhecimento" });
    const b = articleSchema.parse(request.body);
    const { count } = await prisma.kbArticle.updateMany({
      where: { id: request.params.id, tenantId },
      data: {
        title: b.title,
        body: b.body,
        category: b.category ?? null,
        ...(b.isPublished !== undefined && { isPublished: b.isPublished }),
        ...(b.aiEnabled !== undefined && { aiEnabled: b.aiEnabled }),
        updatedById: sub,
      },
    });
    if (count === 0) return reply.status(404).send({ error: "Artigo não encontrado" });
    return prisma.kbArticle.findUnique({ where: { id: request.params.id } });
  });

  fastify.delete<{ Params: { id: string } }>("/tenant/kb/:id", { preHandler }, async (request, reply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores apagam artigos" });
    const { count } = await prisma.kbArticle.deleteMany({ where: { id: request.params.id, tenantId } });
    if (count === 0) return reply.status(404).send({ error: "Artigo não encontrado" });
    return reply.status(204).send();
  });
};
