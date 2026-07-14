import fp from "fastify-plugin";
import { prisma } from "@falai/db";
import type { AuditActorType } from "@falai/shared";

export interface AuditParams {
  actorType: AuditActorType;
  actorId: string;
  tenantId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    audit: (params: AuditParams) => Promise<void>;
  }
}

export default fp(async (fastify) => {
  fastify.decorate("audit", async (params: AuditParams) => {
    await prisma.auditLog.create({
      data: {
        actorType: params.actorType,
        actorId: params.actorId,
        tenantId: params.tenantId ?? null,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        // Spread only when defined — exactOptionalPropertyTypes requires no `undefined` for nullable JSON
        ...(params.before !== undefined && { before: params.before as object }),
        ...(params.after !== undefined && { after: params.after as object }),
        ip: params.ip ?? null,
      },
    });
  });
});
