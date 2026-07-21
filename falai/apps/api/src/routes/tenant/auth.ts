import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "crypto";
import { prisma } from "@falai/db";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  generateTotpQrCode,
  verifyTotp,
  issueTenantToken,
  pending2FaTenantKey,
} from "../../services/auth.service.js";
import { computeFeatures } from "../../services/features.js";

// Selecção comum do tenant devolvida ao CRM (login e /me)
const tenantClientSelect = {
  id: true,
  name: true,
  status: true,
  balanceCents: true,
  features: true,
  plan: { select: { name: true, productType: true, aiAgentsEnabled: true, clinicEnabled: true, smsEnabled: true, maxAgents: true, maxConcurrent: true } },
} as const;

// Substitui o campo `features` cru (overrides) pelas features efectivas calculadas
function shapeTenant<T extends { features: unknown; plan: { aiAgentsEnabled: boolean } | null }>(
  tenant: T | null,
) {
  if (!tenant) return null;
  return {
    ...tenant,
    features: computeFeatures({
      overrides: tenant.features,
      aiAgentsEnabled: tenant.plan?.aiAgentsEnabled ?? true,
    }),
  };
}

const PENDING_2FA_TTL = 5 * 60;

const registerSchema = z.object({
  tenantName: z.string().min(2).max(150),
  tenantEmail: z.string().email(),
  tenantPhone: z.string().min(7).max(20),
  tenantNif: z.string().optional(),
  ownerName: z.string().min(2).max(100),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const totpSchema = z.object({
  sessionToken: z.string().min(1),
  code: z.string().length(6),
});

export const tenantAuthRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.verifyTenant];

  // POST /tenant/auth/register — self-service registration
  fastify.post("/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);

    // Must have at least one active plan to assign
    const defaultPlan = await prisma.plan.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
    if (!defaultPlan) {
      return reply.status(503).send({ error: "Plataforma ainda não tem planos disponíveis. Contacta o suporte." });
    }

    const existingUser = await prisma.tenantUser.findUnique({ where: { email: body.ownerEmail } });
    if (existingUser) return reply.status(409).send({ error: "Email já registado" });

    const tenant = await prisma.tenant.create({
      data: {
        name: body.tenantName,
        email: body.tenantEmail,
        phone: body.tenantPhone,
        ...(body.tenantNif !== undefined && { nif: body.tenantNif }),
        planId: defaultPlan.id,
        status: "TRIAL",
        users: {
          create: {
            name: body.ownerName,
            email: body.ownerEmail,
            passwordHash: await hashPassword(body.ownerPassword),
            role: "OWNER",
          },
        },
      },
      include: {
        users: { select: { id: true, email: true, role: true } },
      },
    });

    await fastify.audit({
      actorType: "SYSTEM",
      actorId: "self-register",
      action: "tenant.registered",
      targetType: "Tenant",
      targetId: tenant.id,
      after: { name: tenant.name, email: tenant.email } as object,
      ip: request.ip,
    });

    return reply.status(201).send({
      tenantId: tenant.id,
      tenantName: tenant.name,
      status: tenant.status,
    });
  });

  // POST /tenant/auth/login
  fastify.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.tenantUser.findUnique({
      where: { email: body.email },
      include: { tenant: { select: { id: true, status: true, deletedAt: true } } },
    });

    if (!user) return reply.status(401).send({ error: "Credenciais inválidas" });

    const tenantOk = user.tenant && !user.tenant.deletedAt &&
      user.tenant.status !== "SUSPENDED" && user.tenant.status !== "CLOSED";
    if (!tenantOk) return reply.status(403).send({ error: "Conta suspensa ou encerrada" });

    const passwordOk = await verifyPassword(user.passwordHash, body.password);
    if (!passwordOk) {
      await fastify.audit({
        actorType: "TENANT_USER",
        actorId: user.id,
        action: "tenant.login.failed",
        targetType: "TenantUser",
        targetId: user.id,
        ip: request.ip,
      });
      return reply.status(401).send({ error: "Credenciais inválidas" });
    }

    if (!user.twoFaSecret) {
      const token = await issueTenantToken(fastify, user.id);
      await prisma.tenantUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await fastify.audit({
        actorType: "TENANT_USER",
        actorId: user.id,
        action: "tenant.login",
        targetType: "TenantUser",
        targetId: user.id,
        ip: request.ip,
      });
      const tenantRecord = await prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: tenantClientSelect,
      });
      return {
        token,
        requiresTwoFactor: false,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, twoFaEnabled: false },
        tenant: shapeTenant(tenantRecord),
      };
    }

    const sessionToken = randomBytes(32).toString("hex");
    await fastify.redis.set(pending2FaTenantKey(sessionToken), user.id, "EX", PENDING_2FA_TTL);
    return reply.status(200).send({ requiresTwoFactor: true, token: sessionToken });
  });

  // POST /tenant/auth/2fa/verify
  fastify.post("/2fa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = totpSchema.parse(request.body);

    const userId = await fastify.redis.get(pending2FaTenantKey(body.sessionToken));
    if (!userId) return reply.status(401).send({ error: "Sessão expirada ou inválida" });

    const user = await prisma.tenantUser.findUnique({ where: { id: userId } });
    if (!user?.twoFaSecret) return reply.status(401).send({ error: "Sessão inválida" });

    if (!verifyTotp(user.twoFaSecret, body.code)) {
      return reply.status(401).send({ error: "Código 2FA inválido" });
    }

    await fastify.redis.del(pending2FaTenantKey(body.sessionToken));
    const token = await issueTenantToken(fastify, user.id);
    await prisma.tenantUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: user.id,
      action: "tenant.login",
      targetType: "TenantUser",
      targetId: user.id,
      ip: request.ip,
    });

    return { token };
  });

  // POST /tenant/auth/2fa/setup — protected
  fastify.post("/2fa/setup", { preHandler }, async (request) => {
    const user = request.tenantUser!;
    const secret = generateTotpSecret();
    const qrCode = await generateTotpQrCode(user.email, secret);
    await fastify.redis.set(`tenant:2fa:setup:${user.sub}`, secret, "EX", 10 * 60);
    return { secret, qrCode };
  });

  // POST /tenant/auth/2fa/confirm — protected
  fastify.post<{ Body: { code: string } }>("/2fa/confirm", { preHandler }, async (request, reply) => {
    const user = request.tenantUser!;
    const { code } = request.body;

    const secret = await fastify.redis.get(`tenant:2fa:setup:${user.sub}`);
    if (!secret) return reply.status(400).send({ error: "Setup 2FA expirado. Recomeça o processo." });
    if (!verifyTotp(secret, code)) return reply.status(400).send({ error: "Código inválido" });

    await prisma.tenantUser.update({ where: { id: user.sub }, data: { twoFaSecret: secret } });
    await fastify.redis.del(`tenant:2fa:setup:${user.sub}`);

    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: user.sub,
      action: "tenant.2fa.enabled",
      targetType: "TenantUser",
      targetId: user.sub,
      ip: request.ip,
    });

    return { ok: true };
  });

  // GET /tenant/auth/me — current session info
  fastify.get("/me", { preHandler }, async (request) => {
    const user = request.tenantUser!;
    const tenantUser = await prisma.tenantUser.findUniqueOrThrow({
      where: { id: user.sub },
      include: { tenant: { select: tenantClientSelect } },
    });
    return {
      user: {
        id: tenantUser.id,
        name: tenantUser.name,
        email: tenantUser.email,
        role: tenantUser.role,
        twoFaEnabled: !!tenantUser.twoFaSecret,
      },
      tenant: shapeTenant(tenantUser.tenant),
    };
  });
};
