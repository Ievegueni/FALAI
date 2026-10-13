import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@falai/db";
import { COMMENT_ASK, COMMENT_THANKS, LOW_SCORE, csatConfigSchema, csatPrompt, csatSummary, csatThanksPrompt, tenantCsatConfig } from "../../services/csat.service.js";
import { isOpsManager, userScope } from "../../services/userScope.js";
import { buildCsatReport, csatScopeWhere } from "../../services/csat.service.js";
import { csatWorkbook } from "../../services/excelExport.service.js";

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

  /** Período do pedido (dias locais AAAA-MM-DD); por omissão os últimos 30 dias. */
  const range = (q: z.infer<typeof rangeSchema>) => {
    const to = q.to ? new Date(`${q.to}T23:59:59.999`) : new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(to.getTime() - 29 * 86_400_000);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  };

  // GET /tenant/reports/csat — média, % satisfeitos, distribuição, por canal/agente/grupo/dia e as negativas
  fastify.get("/tenant/reports/csat", { preHandler, config: { feature: "reports" } }, async (request) => {
    const { from, to } = range(rangeSchema.parse(request.query));
    return buildCsatReport(request.tenantUser!.tenantId, await userScope(request.tenantUser!), from, to);
  });

  // GET /tenant/reports/csat.xlsx — o mesmo, em Excel
  fastify.get("/tenant/reports/csat.xlsx", { preHandler, config: { feature: "reports" } }, async (request, reply) => {
    const { tenantId } = request.tenantUser!;
    const { from, to } = range(rangeSchema.parse(request.query));
    const [report, tenant] = await Promise.all([
      buildCsatReport(tenantId, await userScope(request.tenantUser!), from, to),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    ]);
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="satisfacao_${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.xlsx"`)
      .send(await csatWorkbook(report, tenant.name));
  });

  // PUT /tenant/csat/:id/review — marcar uma avaliação negativa como tratada (ou reabrir), com nota
  fastify.put<{ Params: { id: string } }>("/tenant/csat/:id/review", { preHandler }, async (request, reply) => {
    const { tenantId, role, sub } = request.tenantUser!;
    if (!isOpsManager(role) && role !== "SUPERVISOR") return reply.status(403).send({ error: "Só a supervisão trata avaliações" });
    const body = z.object({ reviewed: z.boolean(), note: z.string().trim().max(2000).nullable().optional() }).parse(request.body);
    const scope = await userScope(request.tenantUser!);
    const r = await prisma.csatResponse.findFirst({ where: { id: request.params.id, tenantId, ...csatScopeWhere(scope) }, select: { id: true } });
    if (!r) return reply.status(404).send({ error: "Avaliação não encontrada" });
    const data = body.reviewed
      ? { reviewedAt: new Date(), reviewedById: sub, reviewNote: body.note ?? null }
      : { reviewedAt: null, reviewedById: null, reviewNote: null };
    await prisma.csatResponse.update({ where: { id: r.id }, data });
    await fastify.audit({ actorType: "TENANT_USER", actorId: sub, tenantId, action: body.reviewed ? "tenant.csat.reviewed" : "tenant.csat.reopened", targetType: "CsatResponse", targetId: r.id, after: data, ip: request.ip });
    return { ok: true };
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
      const { count } = await prisma.csatResponse.updateMany({ where: { id: r.id, score: null }, data: { score, answeredAt: new Date() } });
      const thanks = `<p>${esc((await tenantCsatConfig(r.tenantId)).thanks)}</p>`;
      // Nota baixa: pede o comentário na mesma página.
      if (!count || score > LOW_SCORE) return page(thanks);
      return page(
        `${thanks}<p>${esc(COMMENT_ASK)}</p><form method="post" action="/public/csat/${esc(request.params.token)}/comment" style="flex-direction:column">` +
          `<textarea name="comment" rows="4" maxlength="2000" required style="width:100%;font:inherit;padding:.5rem;border-radius:.5rem;border:1px solid #ccc"></textarea>` +
          `<button type="submit" style="width:auto;padding:0 1.5rem;font-size:1rem">Enviar</button></form>`
      );
    }
  );

  fastify.post<{ Params: { token: string } }>(
    "/public/csat/:token/comment",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const comment = String((request.body as { comment?: unknown } | null)?.comment ?? "").trim().slice(0, 2000);
      reply.type("text/html; charset=utf-8");
      if (!comment) return reply.status(400).send(page("<p>Escreva o comentário.</p>"));
      // Só numa avaliação baixa e uma vez.
      const { count } = await prisma.csatResponse.updateMany({
        where: { token: request.params.token, score: { lte: LOW_SCORE }, comment: null },
        data: { comment },
      });
      return page(`<p>${count ? esc(COMMENT_THANKS) : "Link inválido ou comentário já enviado."}</p>`);
    }
  );
};
