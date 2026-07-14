import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { testCallSchema } from "@falai/shared";
import type { YeastarAdapter } from "@falai/providers";

const DEFAULT_TEST_MESSAGE = "Isto é um teste da plataforma Falaí. A ligação foi estabelecida com sucesso.";

export const adminTestCallRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // POST /admin/test-call
  fastify.post("/", { preHandler }, async (request, reply) => {
    const body = testCallSchema.parse(request.body);
    const admin = request.adminUser!;

    const fromExtension = process.env["YEASTAR_TEST_EXTENSION"] ?? "1000";
    const message = body.message ?? DEFAULT_TEST_MESSAGE;

    fastify.log.info({ action: "test_call.initiated", toNumber: body.toNumber, adminId: admin.sub });

    let providerCallId: string;
    try {
      const result = await (fastify.yeastar as YeastarAdapter).dial({
        fromExtension,
        to: body.toNumber,
        ref: `test_${Date.now()}`,
      });
      providerCallId = result.providerCallId;
    } catch (err) {
      fastify.log.error({ err }, "test_call.dial_failed");
      return reply.status(502).send({ error: "Falha ao iniciar chamada de teste. Verifica a configuração do PBX." });
    }

    let tenantId: string;
    let agentId: string;
    try {
      tenantId = await getFirstActiveTenantId();
      agentId = await getTestAgentId();
    } catch (err) {
      fastify.log.warn({ err }, "test_call.no_tenant_or_agent");
      return reply.status(400).send({ error: "Nenhum tenant/agente activo. Cria um tenant e agente primeiro." });
    }

    const call = await prisma.call.create({
      data: {
        tenantId,
        agentId,
        toNumber: body.toNumber,
        status: "DIALING",
        yeastarCallId: providerCallId,
        variables: { testMessage: message, adminId: admin.sub },
      },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "test_call.initiated",
      targetType: "Call",
      targetId: call.id,
      after: { toNumber: body.toNumber, providerCallId },
      ip: request.ip,
    });

    fastify.log.info({ action: "test_call.dialed", callId: call.id, providerCallId });

    return {
      callId: call.id,
      providerCallId,
      status: "DIALING",
      message: `Chamada de teste iniciada para ${body.toNumber}`,
    };
  });
};

async function getFirstActiveTenantId(): Promise<string> {
  const tenant = await prisma.tenant.findFirst({
    where: { status: "ACTIVE", deletedAt: null },
    select: { id: true },
  });
  if (!tenant) throw new Error("No active tenant");
  return tenant.id;
}

async function getTestAgentId(): Promise<string> {
  const agent = await prisma.agent.findFirst({
    where: { status: "ACTIVE", isApproved: true },
    select: { id: true },
  });
  if (!agent) throw new Error("No active agent");
  return agent.id;
}
