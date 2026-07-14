import fp from "fastify-plugin";
import type { FastifyRequest, FastifyReply } from "fastify";
import { resolveApiKey, hasScope } from "../services/apiKey.service.js";

export interface ResolvedApiKey {
  id: string;
  tenantId: string;
  scopes: string[];
  label: string;
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
        };
      }
  );
});
