import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma, type Prisma } from "@falai/db";
import { FormError, cleanValues, normalizeFields, type FormField } from "../../services/contactForms.service.js";
import { isOpsManager } from "../../services/userScope.js";

/**
 * Fichas de recolha de dados (ver services/contactForms.service.ts).
 *   Gerir: admin/gestor. Preencher: quem atende, no painel da chamada.
 * Os valores vão para Contact.attributes e, se se souber a chamada, uma cópia
 * para Call.formData.
 */

const formSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fields: z.unknown(),
  groupIds: z.array(z.string()).max(200).optional(),
  isActive: z.boolean().optional(),
});
const fillSchema = z.object({
  formId: z.string(),
  values: z.record(z.string(), z.unknown()),
  legId: z.string().optional(), // chamada de entrada (perna do webphone)
});

export const tenantContactFormsRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];
  const config = { feature: ["webphone", "calls"] as ("webphone" | "calls")[] };

  fastify.get<{ Querystring: { all?: string } }>("/tenant/contact-forms", { preHandler, config }, async (request) => {
    const data = await prisma.contactForm.findMany({
      where: { tenantId: request.tenantUser!.tenantId, ...(request.query.all ? {} : { isActive: true }) },
      orderBy: { name: "asc" },
    });
    return { data };
  });

  const save = (id: string | null) => async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId, role } = request.tenantUser!;
    if (!isOpsManager(role)) return reply.status(403).send({ error: "Apenas administradores ou gestores" });
    const body = formSchema.parse(request.body);
    let fields: FormField[];
    try {
      fields = normalizeFields(body.fields);
    } catch (err) {
      if (err instanceof FormError) return reply.status(400).send({ error: err.message });
      throw err;
    }
    if (body.groupIds?.length) {
      const own = await prisma.extensionGroup.count({ where: { tenantId, id: { in: body.groupIds } } });
      if (own !== new Set(body.groupIds).size) return reply.status(400).send({ error: "Grupo inválido" });
    }
    const data = {
      name: body.name,
      fields,
      ...(body.groupIds && { groupIds: [...new Set(body.groupIds)] }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    };
    if (!id) {
      const row = await prisma.contactForm.create({ data: { tenantId, ...data } }).catch(() => null);
      return row ? reply.status(201).send(row) : reply.status(409).send({ error: "Já existe uma ficha com esse nome" });
    }
    const res = await prisma.contactForm.updateMany({ where: { id, tenantId }, data }).catch(() => null);
    if (!res) return reply.status(409).send({ error: "Já existe uma ficha com esse nome" });
    if (res.count === 0) return reply.status(404).send({ error: "Ficha não encontrada" });
    return prisma.contactForm.findUnique({ where: { id } });
  };
  fastify.post("/tenant/contact-forms", { preHandler, config }, save(null));
  fastify.put<{ Params: { id: string } }>("/tenant/contact-forms/:id", { preHandler, config }, (request, reply) => save(request.params.id)(request, reply));

  // POST /tenant/callers/:contactId/form — grava a ficha no perfil do cliente
  fastify.post<{ Params: { contactId: string } }>("/tenant/callers/:contactId/form", { preHandler, config }, async (request, reply) => {
    const { tenantId, sub } = request.tenantUser!;
    const body = fillSchema.parse(request.body);
    const [form, contact] = await Promise.all([
      prisma.contactForm.findFirst({ where: { id: body.formId, tenantId, isActive: true } }),
      prisma.contact.findFirst({ where: { id: request.params.contactId, tenantId }, select: { id: true, attributes: true } }),
    ]);
    if (!form) return reply.status(400).send({ error: "Ficha inválida" });
    if (!contact) return reply.status(404).send({ error: "Contacto não encontrado" });
    let values: ReturnType<typeof cleanValues>;
    try {
      values = cleanValues(form.fields as FormField[], body.values);
    } catch (err) {
      if (err instanceof FormError) return reply.status(400).send({ error: err.message });
      throw err;
    }

    const attributes = { ...((contact.attributes as Record<string, unknown> | null) ?? {}), ...values };
    for (const [k, v] of Object.entries(values)) if (v === null) delete attributes[k];
    await prisma.contact.update({ where: { id: contact.id }, data: { attributes: attributes as Prisma.InputJsonValue } });

    // ponytail: só as chamadas de entrada (legId) guardam a cópia — as de saída
    // do webphone não têm id no browser. Ligar quando a saída passar a ter.
    if (body.legId) {
      const leg = await prisma.callLeg.findFirst({ where: { id: body.legId, tenantId }, select: { callId: true } });
      if (leg) {
        await prisma.call.updateMany({
          where: { id: leg.callId, tenantId },
          data: { formData: { formId: form.id, form: form.name, values, by: sub, at: new Date().toISOString() } },
        });
      }
    }
    await fastify.audit({
      actorType: "TENANT_USER", actorId: sub, tenantId, action: "contact.form_filled",
      targetType: "Contact", targetId: contact.id, after: { formId: form.id, keys: Object.keys(values) }, ip: request.ip,
    });
    return { ok: true, attributes };
  });
};
