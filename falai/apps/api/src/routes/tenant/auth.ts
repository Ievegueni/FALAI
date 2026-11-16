import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "crypto";
import { prisma } from "@falai/db";
import { z } from "zod";
import {
  hashPassword,
  verifyPasswordOrDummy,
  generateTotpSecret,
  generateTotpQrCode,
  verifyTotp,
  verifyTotpOnce,
  sealTotpSecret,
  issueTenantToken,
  pending2FaTenantKey,
  isLoginLocked,
  recordLoginFailure,
  clearLoginFailures,
  LOCKED_MESSAGE,
  createPending2Fa,
  takePending2FaAttempt,
  endPending2Fa,
  tenantRoleRequires2Fa,
} from "../../services/auth.service.js";
import { computeFeatures } from "../../services/features.js";
import { applyProfile, sanitizePermissions, type ProfilePermissions } from "../../services/accessProfiles.js";

// Selecção comum do tenant devolvida ao CRM (login e /me)
const tenantClientSelect = {
  id: true,
  name: true,
  status: true,
  balanceCents: true,
  features: true,
  logoDataUrl: true,
  plan: { select: { name: true, productType: true, aiAgentsEnabled: true, clinicEnabled: true, smsEnabled: true, maxAgents: true, maxConcurrent: true } },
} as const;

// Substitui o campo `features` cru (overrides) pelas features efectivas calculadas,
// já sem os módulos que o perfil de acesso do utilizador esconde
function shapeTenant<
  T extends { features: unknown; plan: { aiAgentsEnabled: boolean; smsEnabled?: boolean; productType?: string } | null },
>(tenant: T | null, permissions: ProfilePermissions | null = null) {
  if (!tenant) return null;
  return {
    ...tenant,
    features: applyProfile(computeFeatures({
      overrides: tenant.features,
      aiAgentsEnabled: tenant.plan?.aiAgentsEnabled ?? true,
      ...(tenant.plan?.smsEnabled !== undefined && { smsEnabled: tenant.plan.smsEnabled }),
      ...(tenant.plan?.productType !== undefined && { productType: tenant.plan.productType }),
    }), permissions),
  };
}

// Perfil de acesso a devolver ao CRM (o OWNER nunca é restringido)
function profileOf(user: { role: string; accessProfile: { id: string; name: string; permissions: unknown } | null }) {
  if (user.role === "OWNER" || !user.accessProfile) return null;
  return { id: user.accessProfile.id, name: user.accessProfile.name, permissions: sanitizePermissions(user.accessProfile.permissions) };
}

const accessProfileSelect = { select: { id: true, name: true, permissions: true } } as const;

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
  fastify.post("/register", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
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
    const redis = fastify.redis;

    if (await isLoginLocked(redis, "tenant", body.email)) return reply.status(429).send({ error: LOCKED_MESSAGE });

    const user = await prisma.tenantUser.findUnique({
      where: { email: body.email },
      include: { tenant: { select: { id: true, status: true, deletedAt: true } }, accessProfile: accessProfileSelect },
    });

    // Password primeiro, e com o mesmo custo exista ou não o email: nem o tempo
    // nem a mensagem dizem que emails estão registados.
    const passwordOk = await verifyPasswordOrDummy(user?.passwordHash, body.password);
    if (!user || !passwordOk) {
      await recordLoginFailure(redis, "tenant", body.email);
      if (user) {
        await fastify.audit({
          actorType: "TENANT_USER",
          actorId: user.id,
          action: "tenant.login.failed",
          targetType: "TenantUser",
          targetId: user.id,
          ip: request.ip,
        });
      }
      return reply.status(401).send({ error: "Credenciais inválidas" });
    }
    await clearLoginFailures(redis, "tenant", body.email);

    const tenantOk = user.tenant && !user.tenant.deletedAt &&
      user.tenant.status !== "SUSPENDED" && user.tenant.status !== "CLOSED";
    if (!tenantOk) return reply.status(403).send({ error: "Conta suspensa ou encerrada" });

    // Com 2FA (ou obrigada a ela): fica pendente até o código. Sem 2FA e com
    // 2FA obrigatória, a resposta traz o QR para a activar já neste login.
    if (user.twoFaSecret || tenantRoleRequires2Fa(user.role)) {
      const sessionToken = randomBytes(32).toString("hex");
      if (user.twoFaSecret) {
        await createPending2Fa(redis, pending2FaTenantKey(sessionToken), { userId: user.id });
        return { requiresTwoFactor: true, token: sessionToken };
      }
      const secret = generateTotpSecret();
      await createPending2Fa(redis, pending2FaTenantKey(sessionToken), { userId: user.id, enrollSecret: secret });
      return {
        requiresTwoFactor: true,
        token: sessionToken,
        setup: { secret, qrCode: await generateTotpQrCode(user.email, secret, "Falaí") },
      };
    }

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
    const accessProfile = profileOf(user);
    return {
      token,
      requiresTwoFactor: false,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, twoFaEnabled: false, accessProfile },
      tenant: shapeTenant(tenantRecord, accessProfile?.permissions ?? null),
    };
  });

  // POST /tenant/auth/2fa/verify — código da app; se for a activação obrigatória, grava a 2FA
  fastify.post("/2fa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = totpSchema.parse(request.body);
    const redis = fastify.redis;
    const key = pending2FaTenantKey(body.sessionToken);

    const pending = await takePending2FaAttempt(redis, key);
    if (!pending) return reply.status(401).send({ error: "Sessão expirada ou inválida. Inicie sessão novamente." });

    const user = await prisma.tenantUser.findUnique({ where: { id: pending.userId } });
    const stored = pending.enrollSecret ? sealTotpSecret(pending.enrollSecret) : user?.twoFaSecret;
    if (!user || !stored) return reply.status(401).send({ error: "Sessão inválida" });

    if (!(await verifyTotpOnce(redis, `tenant:${user.id}`, stored, body.code))) {
      return reply.status(401).send({ error: "Código 2FA inválido" });
    }

    await endPending2Fa(redis, key);
    if (pending.enrollSecret) {
      await prisma.tenantUser.update({ where: { id: user.id }, data: { twoFaSecret: stored } });
      await fastify.audit({
        actorType: "TENANT_USER",
        actorId: user.id,
        action: "tenant.2fa.enabled",
        targetType: "TenantUser",
        targetId: user.id,
        ip: request.ip,
      });
    }
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

  // POST /tenant/auth/logout-all — termina a sessão em todos os dispositivos
  fastify.post("/logout-all", { preHandler }, async (request) => {
    const user = request.tenantUser!;
    await prisma.tenantUser.update({ where: { id: user.sub }, data: { tokenVersion: { increment: 1 } } });
    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: user.sub,
      action: "tenant.sessions.revoked",
      targetType: "TenantUser",
      targetId: user.sub,
      ip: request.ip,
    });
    return { ok: true };
  });

  // POST /tenant/auth/2fa/setup — protected
  fastify.post("/2fa/setup", { preHandler }, async (request) => {
    const user = request.tenantUser!;
    const secret = generateTotpSecret();
    const qrCode = await generateTotpQrCode(user.email, secret, "Falaí");
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

    await prisma.tenantUser.update({ where: { id: user.sub }, data: { twoFaSecret: sealTotpSecret(secret) } });
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

  // POST /tenant/auth/2fa/disable — protected, exige o código actual
  fastify.post<{ Body: { code: string } }>("/2fa/disable", { preHandler, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const user = request.tenantUser!;
    const { code } = totpSchema.pick({ code: true }).parse(request.body);
    const row = await prisma.tenantUser.findUnique({ where: { id: user.sub }, select: { twoFaSecret: true, role: true } });
    if (!row?.twoFaSecret) return reply.status(400).send({ error: "A 2FA não está activa" });
    if (tenantRoleRequires2Fa(row.role)) return reply.status(403).send({ error: "A 2FA é obrigatória para o dono da conta" });
    if (!(await verifyTotpOnce(fastify.redis, `tenant:${user.sub}`, row.twoFaSecret, code))) {
      return reply.status(400).send({ error: "Código inválido" });
    }

    await prisma.tenantUser.update({ where: { id: user.sub }, data: { twoFaSecret: null } });
    await fastify.audit({
      actorType: "TENANT_USER",
      actorId: user.sub,
      action: "tenant.2fa.disabled",
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
      include: { tenant: { select: tenantClientSelect }, accessProfile: accessProfileSelect, extension: { select: { number: true } } },
    });
    const accessProfile = profileOf(tenantUser);
    return {
      user: {
        id: tenantUser.id,
        name: tenantUser.name,
        email: tenantUser.email,
        role: tenantUser.role,
        twoFaEnabled: !!tenantUser.twoFaSecret,
        accessProfile,
        // Webphone e screen pop usam a extensão do próprio utilizador.
        extensionId: tenantUser.extensionId,
        extensionNumber: tenantUser.extension?.number ?? null,
      },
      tenant: shapeTenant(tenantUser.tenant, accessProfile?.permissions ?? null),
    };
  });
};
