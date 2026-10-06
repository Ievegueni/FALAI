import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@falai/db";
import { csatConfigSchema, csatPrompt, csatSummary, csatThanksPrompt, tenantCsatConfig } from "../../services/csat.service.js";
import { isOpsManager, userScope } from "../../services/userScope.js";

/**
 * Satisfação (CSAT, fase 8) — ver services/csat.service.ts.
 * Definições: gestor/admin. Relatório: com o âmbito de quem pede.
 */

const rangeSchema = z.object({ from: z.string().optional(), to: z.string().optional() });

export const tenantCsatRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  fastify.get("/tenant/csat/settings", { preHandler }, async (request) => tenantCsatConfig(request.tenantUser!.tenantId));

  fastify.put("/tenant/csat/settings", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const cfg = csatConfigSchema.parse(request.body);
    // Voz: a pergunta e o agradecimento viram áudio agora (TTS), não a meio da chamada.
    if (cfg.voice) {
      try {
        await fastify.callEngine.audioCache.prepareNamedPrompt(csatPrompt(tenantId), cfg.question);
        await fastify.callEngine.audioCache.prepareNamedPrompt(csatThanksPrompt(tenantId), cfg.thanks);
      } catch (err) {
        fastify.log.error({ err, tenantId }, "csat.tts_failed");
        return reply.status(502).send({ error: "Falhou a geração do áudio do inquérito — tente gravar de novo" });
      }
    }
    await prisma.tenant.update({ where: { id: tenantId }, data: { csatConfig: cfg } });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, tenantId, action: "tenant.csat.settings_updated", targetType: "Tenant", targetId: tenantId, after: cfg, ip: request.ip });
    return cfg;
  });

  // GET /tenant/reports/csat — média, % satisfeitos e distribuição, por canal, agente e grupo
  fastify.get("/tenant/reports/csat", { preHandler, config: { feature: "reports" } }, async (request) => {
    const { tenantId } = request.tenantUser!;
    const q = rangeSchema.parse(request.query);
    const to = q.to ? new Date(`${q.to}T23:59:59.999`) : new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(to.getTime() - 29 * 86_400_000);
    from.setHours(0, 0, 0, 0);
    const scope = await userScope(request.tenantUser!);
    const where: Prisma.CsatResponseWhereInput = {
      tenantId,
      createdAt: { gte: from, lte: to },
      ...(scope.kind === "SELF" && { agentId: scope.userId }),
      ...(scope.kind === "TEAM" && { OR: [{ agentId: { in: scope.userIds } }, { groupId: { in: scope.groupIds } }] }),
    };
    const rows = await prisma.csatResponse.findMany({ where, select: { channel: true, score: true, agentId: true, groupId: true } });
    const answered = rows.filter((r): r is typeof r & { score: number } => r.score !== null);
    const [users, groups] = await Promise.all([
      prisma.tenantUser.findMany({ where: { tenantId, id: { in: [...new Set(answered.map((r) => r.agentId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
      prisma.extensionGroup.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const by = (key: (r: (typeof answered)[number]) => string | null, names: Map<string, string>) =>
      [...new Set(answered.map(key))].map((k) => ({
        key: k,
        name: k ? (names.get(k) ?? k) : null,
        ...csatSummary(answered.filter((r) => key(r) === k).map((r) => r.score)),
      })).sort((a, b) => b.responses - a.responses);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      overall: csatSummary(answered.map((r) => r.score)),
      asked: rows.length,
      byChannel: by((r) => r.channel, new Map()),
      byAgent: by((r) => r.agentId, new Map(users.map((u) => [u.id, u.name]))),
      byGroup: by((r) => r.groupId, new Map(groups.map((g) => [g.id, g.name]))),
    };
  });
};

// ─── Página pública do link enviado por SMS ──────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (body: string) =>
  `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Avaliação</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#111;text-align:center}` +
  `form{display:flex;gap:.5rem;justify-content:center;margin-top:1.5rem}button{font-size:1.4rem;width:3rem;height:3rem;border-radius:.75rem;border:1px solid #ccc;background:#fff;cursor:pointer}` +
  `button:hover{background:#eef}p.s{color:#666;font-size:.9rem}</style></head><body>${body}</body></html>`;

export const publicCsatRoutes: FastifyPluginAsync = async (fastify) => {
  // O formulário HTML envia form-urlencoded (o Fastify só percebe JSON de origem).
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.get<{ Params: { token: string } }>("/public/csat/:token", async (request, reply) => {
    const r = await prisma.csatResponse.findUnique({ where: { token: request.params.token }, select: { tenantId: true, score: true } });
    reply.type("text/html; charset=utf-8");
    if (!r) return reply.status(404).send(page("<p>Link inválido.</p>"));
    const cfg = await tenantCsatConfig(r.tenantId);
    if (r.score !== null) return page(`<p>${esc(cfg.thanks)}</p>`);
    const buttons = [1, 2, 3, 4, 5].map((n) => `<button name="score" value="${n}">${n}</button>`).join("");
    return page(`<p>${esc(cfg.question)}</p><form method="post">${buttons}</form><p class="s">1 = nada satisfeito · 5 = muito satisfeito</p>`);
  });

  fastify.post<{ Params: { token: string } }>(
    "/public/csat/:token",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const score = Number((request.body as { score?: unknown } | null)?.score);
      reply.type("text/html; charset=utf-8");
      if (!Number.isInteger(score) || score < 1 || score > 5) return reply.status(400).send(page("<p>Escolha de 1 a 5.</p>"));
      const r = await prisma.csatResponse.findUnique({ where: { token: request.params.token }, select: { id: true, tenantId: true } });
      if (!r) return reply.status(404).send(page("<p>Link inválido.</p>"));
      // Só a primeira resposta conta.
      await prisma.csatResponse.updateMany({ where: { id: r.id, score: null }, data: { score, answeredAt: new Date() } });
      return page(`<p>${esc((await tenantCsatConfig(r.tenantId)).thanks)}</p>`);
    }
  );
};
