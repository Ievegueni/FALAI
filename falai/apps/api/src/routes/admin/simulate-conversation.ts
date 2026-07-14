import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@falai/db";
import { z } from "zod";

const schema = z.object({
  agentId: z.string().cuid(),
  toNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  /** Simulated user utterances (replaces real audio+STT). Up to 10. */
  userUtterances: z.array(z.string().min(1)).min(1).max(10),
  variables: z.record(z.unknown()).optional(),
});

/**
 * POST /admin/simulate-conversation
 *
 * Runs the full LLM→TTS pipeline for N turns with synthetic STT input.
 * Does NOT actually dial Yeastar. Used to verify the conversation engine
 * and collect latency metrics before Sprint 0 (real Yeastar access).
 */
export const adminSimulateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = schema.parse(request.body);
    const admin = request.adminUser!;

    const agent = await prisma.agent.findUnique({ where: { id: body.agentId } });
    if (!agent) return reply.status(404).send({ error: "Agente não encontrado" });
    if (agent.status !== "ACTIVE" || !agent.isApproved) {
      return reply.status(400).send({ error: "Agente não está activo ou aprovado" });
    }

    // Create a synthetic call record
    const call = await prisma.call.create({
      data: {
        tenantId: agent.tenantId,
        agentId: agent.id,
        toNumber: body.toNumber,
        status: "IN_PROGRESS",
        variables: body.variables as object ?? {},
        startedAt: new Date(),
        answeredAt: new Date(),
      },
    });

    fastify.log.info({ callId: call.id, agentId: agent.id, turns: body.userUtterances.length }, "simulate.started");

    const turnResults: Array<{
      seq: number;
      userText: string;
      agentReply: string;
      action: string;
      latencies: { sttMs: number; llmMs: number; ttsMs: number; playMs: number };
    }> = [];

    const history: Array<{ role: "human" | "agent" | "system"; text: string }> = [];
    let finalStatus: "COMPLETED" | "ESCALATED" = "COMPLETED";

    // First turn: greeting (no user text)
    const greetingResult = await fastify.callEngine["cfg"].turnProcessor.processTurn(
      Buffer.alloc(0),
      {
        callId: call.id,
        agentId: agent.id,
        toNumber: body.toNumber,
        providerCallId: `sim_${call.id}`,
        systemPrompt: agent.systemPrompt,
        ttsVoiceId: agent.ttsVoiceId,
        variables: (body.variables ?? {}) as Record<string, unknown>,
        history: [],
        seq: 0,
      }
    );
    history.push({ role: "agent", text: greetingResult.response.reply });
    turnResults.push({
      seq: 0,
      userText: "(início)",
      agentReply: greetingResult.response.reply,
      action: greetingResult.response.action.type,
      latencies: greetingResult.latencies,
    });

    // Process each user utterance
    for (let i = 0; i < body.userUtterances.length; i++) {
      const userText = body.userUtterances[i]!;
      history.push({ role: "human", text: userText });

      // Simulate STT by directly writing a turn (no real audio)
      await prisma.callTurn.create({
        data: {
          callId: call.id,
          seq: i * 2 + 1,
          role: "HUMAN",
          text: userText,
          sttMs: 0, // bypassed — synthetic
        },
      });

      const result = await fastify.callEngine["cfg"].turnProcessor.processTurn(
        Buffer.alloc(0), // empty buffer — STT skipped via seq already written
        {
          callId: call.id,
          agentId: agent.id,
          toNumber: body.toNumber,
          providerCallId: `sim_${call.id}`,
          systemPrompt: agent.systemPrompt,
          ttsVoiceId: agent.ttsVoiceId,
          variables: (body.variables ?? {}) as Record<string, unknown>,
          history,
          seq: i * 2 + 2,
        }
      );

      history.push({ role: "agent", text: result.response.reply });
      turnResults.push({
        seq: i + 1,
        userText,
        agentReply: result.response.reply,
        action: result.response.action.type,
        latencies: result.latencies,
      });

      if (result.response.action.type === "end_call") break;
      if (result.response.action.type === "escalate") { finalStatus = "ESCALATED"; break; }
    }

    await prisma.call.update({
      where: { id: call.id },
      data: { status: finalStatus, endedAt: new Date() },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "simulate_conversation",
      targetType: "Call",
      targetId: call.id,
      after: { agentId: agent.id, turns: turnResults.length },
      ip: request.ip,
    });

    return {
      callId: call.id,
      agentName: agent.name,
      status: finalStatus,
      turns: turnResults,
      latencySummary: {
        avgLlmMs: Math.round(turnResults.reduce((s, t) => s + t.latencies.llmMs, 0) / turnResults.length),
        avgTtsMs: Math.round(turnResults.reduce((s, t) => s + t.latencies.ttsMs, 0) / turnResults.length),
      },
    };
  });
};
