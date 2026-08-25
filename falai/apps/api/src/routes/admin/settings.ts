import type { FastifyPluginAsync } from "fastify";
import { systemSettingUpsertSchema } from "@falai/shared";
import {
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
} from "../../services/settings.service.js";
import {
  BANNED_PHRASES_SETTING,
  invalidateBannedPhrasesCache,
} from "../../services/guardrail.service.js";

export const adminSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // GET /admin/settings
  fastify.get("/", { preHandler }, async () => {
    return { settings: await getAllSettings() };
  });

  // GET /admin/settings/:key
  fastify.get<{ Params: { key: string } }>("/:key", { preHandler }, async (request, reply) => {
    const value = await getSetting(request.params.key);
    if (value === null) return reply.status(404).send({ error: "Setting não encontrada" });
    return { key: request.params.key, value };
  });

  // PUT /admin/settings
  fastify.put("/", {
    preHandler,
    schema: {
      body: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: { type: "string" },
          value: { type: "string" },
          isSecret: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    const body = systemSettingUpsertSchema.parse(request.body);
    const admin = request.adminUser!;

    const before = await getSetting(body.key);
    await upsertSetting({
      key: body.key,
      value: body.value,
      isSecret: body.isSecret ?? false,
      updatedBy: admin.sub,
    });

    // A lista de frases proibidas é lida a cada turno de cada chamada, com
    // cache de 60s. Sem isto, uma frase acrescentada aqui só valia no minuto
    // seguinte — inaceitável para uma regra que se está a pôr por urgência.
    if (body.key === BANNED_PHRASES_SETTING) invalidateBannedPhrasesCache();

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "system_setting.upsert",
      targetType: "SystemSetting",
      targetId: body.key,
      before: body.isSecret ? { value: "***" } : { value: before },
      after: body.isSecret ? { value: "***" } : { value: body.value },
      ip: request.ip,
    });

    return reply.status(200).send({ ok: true });
  });

  // DELETE /admin/settings/:key (apenas SUPERADMIN)
  fastify.delete<{ Params: { key: string } }>("/:key", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    if (admin.role !== "SUPERADMIN") {
      return reply.status(403).send({ error: "Apenas SUPERADMIN pode remover settings" });
    }

    const before = await getSetting(request.params.key);
    if (before === null) return reply.status(404).send({ error: "Setting não encontrada" });

    await deleteSetting(request.params.key);
    if (request.params.key === BANNED_PHRASES_SETTING) invalidateBannedPhrasesCache();

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "system_setting.delete",
      targetType: "SystemSetting",
      targetId: request.params.key,
      ip: request.ip,
    });

    return { ok: true };
  });
};
