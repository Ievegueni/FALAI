import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import type { YeastarAdapter } from "@falai/providers";
import { ingestSharedPbxEvent } from "../services/incomingCalls.service.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket endpoint for Yeastar audio streaming.
 *
 * Protocol:
 *   - First message: JSON { call_id, extension } — identifies the call
 *   - Subsequent messages: binary PCM-16 audio frames at 16kHz mono
 *   - JSON messages at any point: control events (normalised via YeastarAdapter)
 */
export function registerYeastarWebSocket(fastify: FastifyInstance): void {
  fastify.get("/ws/yeastar", { websocket: true }, (socket, request) => {
    fastify.log.info({ ip: request.ip }, "yeastar.ws.connected");

    const yeastar = fastify.yeastar as YeastarAdapter;
    let sessionProviderCallId: string | null = null;

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, HEARTBEAT_INTERVAL_MS);

    socket.on("message", (raw: unknown) => {
      // Binary = PCM audio frame
      if (Buffer.isBuffer(raw)) {
        if (sessionProviderCallId) {
          fastify.callEngine.handleAudioFrame(sessionProviderCallId, raw);
        }
        return;
      }

      // String = JSON control / event message
      try {
        const str = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
        const payload = JSON.parse(str) as Record<string, unknown>;
        fastify.log.debug({ payload }, "yeastar.ws.message");

        // First message from Yeastar identifies the call
        if (!sessionProviderCallId) {
          const callId = (payload["call_id"] ?? payload["callid"]) as string | undefined;
          if (callId) sessionProviderCallId = callId;
        }

        // Pass to adapter for event normalisation
        yeastar.handleRawEvent(payload);

        // Chamada a entrar: screen pop + registo ao vivo (resolve o tenant pela extensão)
        void ingestSharedPbxEvent(fastify, payload).catch((err) =>
          fastify.log.warn({ err }, "yeastar.ws.inbound_ingest_failed")
        );

        // Log errors
        const code = payload["event"] as number | undefined;
        if (code === 30015) {
          prisma.systemEvent.create({
            data: {
              severity: "WARNING",
              source: "yeastar",
              message: `Call failure: ${String(payload["reason"] ?? "unknown")}`,
              payload: payload as object,
            },
          }).catch(console.error);
        }
      } catch (err) {
        fastify.log.warn({ err }, "yeastar.ws.parse_error");
      }
    });

    socket.on("pong", () => fastify.log.debug("yeastar.ws.pong"));

    socket.on("close", (code: number, reason: Buffer) => {
      clearInterval(heartbeat);
      fastify.log.info({ code, reason: reason.toString() }, "yeastar.ws.disconnected");
    });

    socket.on("error", (err: Error) => {
      clearInterval(heartbeat);
      fastify.log.error({ err }, "yeastar.ws.error");
    });
  });
}
