import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getTenantTelephony, hasOwnPbx } from "../../services/tenantTelephony.service.js";
import { prisma } from "@falai/db";
import { resolveOutboundExtension, NoOutboundLineError } from "../../services/outboundExtension.service.js";
import { reserveBalance } from "../../services/billing.service.js";

const bodySchema = z.object({
  to: z.string().min(5, "Número de destino obrigatório"),
  code: z.string().min(4).max(12).regex(/^\d+$/, "O código deve conter apenas dígitos"),
  fromExtension: z.string().optional(),
  // Extensão com permissões de saída (outbound route) para números externos.
  // Se omitido, usa fromExtension. Configura no Yeastar qual extensão tem trunk de saída.
  dialPermission: z.string().optional(),
  language: z.enum(["pt", "en"]).optional().default("pt"),
  // "yes" → extensão de origem atende automaticamente e liga ao destino (padrão OTP)
  // "no" → extensão de origem toca à espera que um humano atenda antes de ligar ao destino
  autoAnswer: z.enum(["yes", "no"]).optional().default("yes"),
});

export async function v1OtpRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/otp/call
   *
   * Inicia uma chamada de voz ao número indicado e dita o código OTP fornecido.
   * A chamada termina automaticamente após a leitura do código.
   *
   * O cliente é responsável por gerar e verificar o código — a plataforma
   * apenas faz a entrega por voz.
   *
   * Requer scope: otp:call
   * Suportado apenas em planos VOICE_AI (PBX da plataforma).
   */
  fastify.post("/v1/otp/call", { preHandler: [fastify.verifyScope("otp:call")] }, async (request, reply) => {
    const tenantId = request.apiKey!.tenantId;

    const result = bodySchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: result.error.issues[0]?.message ?? "Dados inválidos" });
    }
    const { to, code, language, autoAnswer, dialPermission } = result.data;

    // Verificar plano — OTP por voz só está disponível em VOICE_AI (PBX da plataforma)
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        pbxBaseUrl: true, pbxClientId: true, pbxClientSecret: true,
        plan: { select: { productType: true, aiAgentsEnabled: true, pricePerCallCents: true } },
      },
    });
    if (!tenant) return reply.status(404).send({ error: "Tenant não encontrado" });

    if (hasOwnPbx(tenant)) {
      return reply.status(422).send({
        error: "Chamadas OTP não estão disponíveis em planos CRM BYO-PBX. Use o plano VOICE_AI.",
      });
    }

    // Extensão de saída: parâmetro da request > linha default do cliente
    let fromExtension: string;
    try {
      fromExtension = await resolveOutboundExtension(tenantId, result.data.fromExtension);
    } catch (err) {
      if (err instanceof NoOutboundLineError) {
        return reply.status(422).send({ error: "O cliente não tem nenhuma linha de saída activa configurada." });
      }
      throw err;
    }

    // OTP é sempre cobrado por chamada (flat). Debita já; se não houver saldo, recusa.
    const otpCostCents = tenant.plan.pricePerCallCents;
    if (otpCostCents > 0) {
      const paid = await reserveBalance(tenantId, otpCostCents);
      if (!paid) return reply.status(402).send({ error: "Saldo insuficiente" });
    }

    const telephony = await getTenantTelephony(fastify, tenantId);

    try {
      const { providerCallId } = await fastify.otpCallService.initiateCall({
        to,
        code,
        fromExtension,
        ...(dialPermission && { dialPermission }),
        language,
        autoAnswer,
        telephony,
      });

      fastify.log.info({ tenantId, to, providerCallId }, "v1.otp.call_initiated");

      // Persistir no histórico do CRM. A entrega por play_prompt é fire-and-forget
      // (sem eventos de fim), por isso registamos como COMPLETED no momento do envio.
      const callRecord = await prisma.call
        .create({
          data: {
            tenantId,
            kind: "OTP",
            toNumber: to,
            status: "COMPLETED",
            costCents: otpCostCents,
            startedAt: new Date(),
            endedAt: new Date(),
          },
          select: { id: true },
        })
        .catch((err: unknown) => {
          fastify.log.error({ err, tenantId, to }, "v1.otp.persist_failed");
          return null;
        });

      // Regista o movimento de carteira (débito já feito acima)
      if (otpCostCents > 0) {
        const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { balanceCents: true } });
        await prisma.walletTransaction.create({
          data: {
            tenantId,
            type: "CALL_CHARGE",
            amountCents: -otpCostCents,
            balanceAfterCents: t.balanceCents,
            note: `OTP por voz — ${to}`,
            ...(callRecord?.id ? { reference: callRecord.id } : {}),
          },
        }).catch((err: unknown) => fastify.log.error({ err, tenantId }, "v1.otp.charge_persist_failed"));
      }

      return reply.status(202).send({
        providerCallId,
        callId: callRecord?.id ?? null,
        costCents: otpCostCents,
        to,
        status: "dialing",
        message: "Chamada iniciada. O código será ditado assim que o destinatário atender.",
      });
    } catch (err) {
      // Reembolsa o débito de OTP se a chamada não chegou a arrancar
      if (otpCostCents > 0) {
        await prisma.$executeRaw`UPDATE "Tenant" SET "balanceCents" = "balanceCents" + ${otpCostCents} WHERE id = ${tenantId}`;
      }
      fastify.log.error({ err, tenantId, to }, "v1.otp.call_failed");
      return reply.status(502).send({ error: "Não foi possível iniciar a chamada. Verifica o número e tenta novamente." });
    }
  });
}
