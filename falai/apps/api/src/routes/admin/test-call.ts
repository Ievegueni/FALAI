import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { testCallSchema } from "@falai/shared";

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

    // Primeiro os pré-requisitos, só depois se marca. Ao contrário: a chamada
    // saía, o telefone tocava, e a API respondia erro — deixando uma chamada
    // real sem registo nenhum na base de dados.
    const tenantId = await getFirstActiveTenantId();
    if (!tenantId) {
      return reply.status(400).send({ error: "Nenhum cliente activo. Cria um cliente antes de testar." });
    }
    // O agente é opcional: uma chamada de teste serve para provar a telefonia,
    // não a IA. Sem agente aprovado a chamada faz-se na mesma.
    const agentId = await getTestAgentId();

    let providerCallId: string;
    try {
      const result = await fastify.telephony.dial({
        fromExtension,
        to: body.toNumber,
        ref: `test_${Date.now()}`,
      });
      providerCallId = result.providerCallId;
    } catch (err) {
      fastify.log.error({ err }, "test_call.dial_failed");
      const details = err instanceof Error ? err.message : String(err);
      return reply
        .status(502)
        .send({ error: `O motor recusou a chamada: ${details}` });
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

async function getFirstActiveTenantId(): Promise<string | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { status: "ACTIVE", deletedAt: null },
    select: { id: true },
  });
  return tenant?.id ?? null;
}

async function getTestAgentId(): Promise<string | null> {
  const agent = await prisma.agent.findFirst({
    where: { status: "ACTIVE", isApproved: true },
    select: { id: true },
  });
  return agent?.id ?? null;
}
