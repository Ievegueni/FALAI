import type { FastifyPluginAsync } from "fastify";
import { utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { resolveProviderConfig } from "../../services/providerConfig.service.js";

/**
 * Estado e reinício da API a partir do backoffice (Configurações).
 *
 * As chaves dos provedores e o modo de teste da IA são lidos no arranque;
 * "Reiniciar API" aplica-os sem acesso ao servidor:
 * - produção (pm2): a API fecha e sai; o pm2 volta a arrancá-la;
 * - dev (`tsx watch`): toca no ficheiro de entrada e o watch reinicia.
 * As chamadas em curso caem — o backoffice avisa antes.
 */

const STARTED_AT = new Date();
const ENTRY = fileURLToPath(new URL("../../index.ts", import.meta.url));

const summary = (p: { aiStubMode: boolean; anthropic: { apiKey: string } }) => ({
  aiStubMode: p.aiStubMode,
  anthropicConfigured: !!p.anthropic.apiKey,
});

export const adminSystemRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/system/status — o que está em uso vs o que está guardado
  fastify.get("/status", { preHandler }, async () => {
    const running = summary(fastify.providerConfig);
    const saved = summary(await resolveProviderConfig());
    return {
      startedAt: STARTED_AT.toISOString(),
      env: config.NODE_ENV,
      running,
      saved,
      // Só conta o que este ecrã mostra; outras chaves guardadas também esperam pelo reinício.
      pendingRestart: running.aiStubMode !== saved.aiStubMode || running.anthropicConfigured !== saved.anthropicConfigured,
    };
  });

  // POST /admin/system/restart — reinicia a API para aplicar as configurações
  fastify.post("/restart", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    if (admin.role !== "SUPERADMIN") return reply.status(403).send({ error: "Apenas SUPERADMIN pode reiniciar a API" });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "system.api_restart",
      targetType: "System",
      targetId: "api",
      ip: request.ip,
    });
    fastify.log.warn({ by: admin.sub }, "api.restart_requested");

    // Responde primeiro; reinicia logo a seguir.
    setTimeout(() => void restart(), 300);
    return { ok: true, startedAt: STARTED_AT.toISOString() };
  });

  async function restart() {
    if (config.NODE_ENV !== "production") {
      // tsx watch reinicia quando o ficheiro de entrada muda.
      const now = new Date();
      // Sem watch não reinicia; o backoffice vê que startedAt não mudou e avisa.
      await utimes(ENTRY, now, now).catch((err) => fastify.log.error({ err }, "api.restart_touch_failed"));
      return;
    }
    await fastify.close().catch(() => {});
    process.exit(0); // pm2 volta a arrancar (ecosystem.config.cjs)
  }
};
