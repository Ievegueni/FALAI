import fp from "fastify-plugin";
import { prisma } from "@falai/db";
import type { FastifyRequest, FastifyReply } from "fastify";
import { resolveApiKey, hasScope } from "../services/apiKey.service.js";
import { ipMatchesAllowlist } from "../services/ipAllowlist.js";

export interface ResolvedApiKey {
  id: string;
  tenantId: string;
  scopes: string[];
  label: string;
  /** Prefixo visível da chave ("fal_live_XXXXXXX") — para logs e auditoria. */
  prefix: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Returns a preHandler that verifies an API key and checks a scope. */
    verifyScope: (scope: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    apiKey?: ResolvedApiKey;
  }
}

/**
 * Rejeições já registadas, por (chave, IP). O evento de auditoria é útil uma
 * vez; escrito a cada pedido, deixa quem tenha uma chave roubada encher a
 * tabela `SystemEvent` ao ritmo que quiser — e a rejeição acontece no
 * preHandler, antes de qualquer rate-limit. O log do Fastify continua a sair
 * sempre; esse é barato e vai para outro sítio.
 */
const REJECTION_LOG_TTL_MS = 5 * 60_000;
const loggedRejections = new Map<string, number>();

function shouldLogRejection(apiKeyId: string, ip: string): boolean {
  const key = `${apiKeyId}:${ip}`;
  const now = Date.now();

  const last = loggedRejections.get(key);
  if (last !== undefined && now - last < REJECTION_LOG_TTL_MS) return false;

  // Limpeza oportunista: sem isto o mapa cresceria com IPs que nunca voltam.
  if (loggedRejections.size > 1000) {
    for (const [k, at] of loggedRejections) {
      if (now - at >= REJECTION_LOG_TTL_MS) loggedRejections.delete(k);
    }
  }

  loggedRejections.set(key, now);
  return true;
}

function extractRawKey(request: FastifyRequest): string | null {
  const auth = request.headers["authorization"];
  if (auth?.startsWith("Bearer fal_")) return auth.slice(7);
  const header = request.headers["x-api-key"];
  if (typeof header === "string") return header;
  return null;
}

export default fp(async (fastify) => {
  fastify.decorate(
    "verifyScope",
    (scope: string) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const rawKey = extractRawKey(request);
        if (!rawKey) {
          return reply.status(401).send({
            error: "API key required",
            hint: "Pass 'Authorization: Bearer fal_live_...' or 'X-API-Key: fal_live_...'",
          });
        }

        const apiKey = await resolveApiKey(rawKey);
        if (!apiKey) {
          return reply.status(401).send({ error: "Invalid, revoked, or expired API key" });
        }

        // Origem da chamada. A chave sozinha não chega quando a chave tem
        // allowedCidrs: tem de vir de um IP conhecido. Fica ANTES do scope de
        // propósito — uma chave roubada não deve sequer saber que scopes tem.
        // Depende de trustProxy (ligado em index.ts) para request.ip ser o IP
        // do cliente e não o do nginx.
        if (!ipMatchesAllowlist(request.ip, apiKey.allowedCidrs)) {
          fastify.log.warn(
            { apiKeyId: apiKey.id, tenantId: apiKey.tenantId, ip: request.ip },
            "api_key.ip_rejected"
          );
          if (shouldLogRejection(apiKey.id, request.ip)) {
            await prisma.systemEvent
              .create({
                data: {
                  severity: "WARNING",
                  source: "api-auth",
                  tenantId: apiKey.tenantId,
                  message: `Chave ${apiKey.prefix} usada a partir de um IP não autorizado (${request.ip})`,
                  payload: { apiKeyId: apiKey.id, ip: request.ip, allowed: apiKey.allowedCidrs },
                },
              })
              .catch(() => {});
          }
          return reply.status(403).send({ error: "Source IP not allowed for this API key" });
        }

        if (!hasScope(apiKey, scope)) {
          return reply.status(403).send({
            error: `Scope '${scope}' required`,
            granted: apiKey.scopes,
          });
        }

        request.apiKey = {
          id: apiKey.id,
          tenantId: apiKey.tenantId,
          scopes: apiKey.scopes,
          label: apiKey.label,
          prefix: apiKey.prefix,
        };
      }
  );
});
