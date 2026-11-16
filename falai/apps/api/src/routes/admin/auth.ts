import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "crypto";
import { prisma } from "@falai/db";
import { adminLoginSchema, adminTotpSchema } from "@falai/shared";
import {
  verifyPasswordOrDummy,
  hashPassword,
  verifyTotp,
  verifyTotpOnce,
  sealTotpSecret,
  generateTotpSecret,
  generateTotpQrCode,
  issueAdminToken,
  pending2FaKey,
  isLoginLocked,
  recordLoginFailure,
  clearLoginFailures,
  LOCKED_MESSAGE,
  createPending2Fa,
  takePending2FaAttempt,
  endPending2Fa,
} from "../../services/auth.service.js";

export const adminAuthRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // POST /admin/auth/login — a 2FA é obrigatória no backoffice: quem ainda não
  // a tem recebe o QR e activa-a neste mesmo login.
  fastify.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = adminLoginSchema.parse(request.body);
    const redis = fastify.redis;

    if (await isLoginLocked(redis, "admin", body.email)) return reply.status(429).send({ error: LOCKED_MESSAGE });

    const admin = await prisma.adminUser.findUnique({ where: { email: body.email } });
    const passwordOk = await verifyPasswordOrDummy(admin?.passwordHash, body.password);
    if (!admin || !passwordOk) {
      await recordLoginFailure(redis, "admin", body.email);
      if (admin) {
        await fastify.audit({
          actorType: "ADMIN",
          actorId: admin.id,
          action: "admin.login.failed",
          targetType: "AdminUser",
          targetId: admin.id,
          ip: request.ip,
        });
      }
      return reply.status(401).send({ error: "Credenciais inválidas" });
    }
    await clearLoginFailures(redis, "admin", body.email);

    const sessionToken = randomBytes(32).toString("hex");
    if (admin.twoFaSecret) {
      await createPending2Fa(redis, pending2FaKey(sessionToken), { userId: admin.id });
      return { requiresTwoFactor: true, token: sessionToken };
    }
    const secret = generateTotpSecret();
    await createPending2Fa(redis, pending2FaKey(sessionToken), { userId: admin.id, enrollSecret: secret });
    return {
      requiresTwoFactor: true,
      token: sessionToken,
      setup: { secret, qrCode: await generateTotpQrCode(admin.email, secret) },
    };
  });

  // POST /admin/auth/2fa/verify — código da app; se for a activação, grava a 2FA
  fastify.post("/2fa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = adminTotpSchema.parse(request.body);
    const redis = fastify.redis;
    const key = pending2FaKey(body.sessionToken);

    const pending = await takePending2FaAttempt(redis, key);
    if (!pending) return reply.status(401).send({ error: "Sessão expirada ou inválida. Inicie sessão novamente." });

    const admin = await prisma.adminUser.findUnique({ where: { id: pending.userId } });
    const stored = pending.enrollSecret ? sealTotpSecret(pending.enrollSecret) : admin?.twoFaSecret;
    if (!admin || !stored) return reply.status(401).send({ error: "Sessão inválida" });

    if (!(await verifyTotpOnce(redis, `admin:${admin.id}`, stored, body.code))) {
      return reply.status(401).send({ error: "Código 2FA inválido" });
    }

    await endPending2Fa(redis, key);
    if (pending.enrollSecret) {
      await prisma.adminUser.update({ where: { id: admin.id }, data: { twoFaSecret: stored } });
      await fastify.audit({
        actorType: "ADMIN",
        actorId: admin.id,
        action: "admin.2fa.enabled",
        targetType: "AdminUser",
        targetId: admin.id,
        ip: request.ip,
      });
    }
    const token = await issueAdminToken(fastify, admin.id);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.id,
      action: "admin.login",
      targetType: "AdminUser",
      targetId: admin.id,
      ip: request.ip,
    });

    return { token };
  });

  // POST /admin/auth/logout-all — termina a sessão em todos os dispositivos
  fastify.post("/logout-all", { preHandler }, async (request) => {
    const admin = request.adminUser!;
    await prisma.adminUser.update({ where: { id: admin.sub }, data: { tokenVersion: { increment: 1 } } });
    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "admin.sessions.revoked",
      targetType: "AdminUser",
      targetId: admin.sub,
      ip: request.ip,
    });
    return { ok: true };
  });

  // POST /admin/auth/2fa/setup
  fastify.post("/2fa/setup", { preHandler }, async (request) => {
    const admin = request.adminUser!;
    const secret = generateTotpSecret();
    const qrCode = await generateTotpQrCode(admin.email, secret);
    await fastify.redis.set(`admin:2fa:setup:${admin.sub}`, secret, "EX", 10 * 60);
    return { secret, qrCode };
  });

  // POST /admin/auth/2fa/confirm
  fastify.post<{ Body: { code: string } }>("/2fa/confirm", { preHandler }, async (request, reply) => {
    const admin = request.adminUser!;
    const { code } = request.body;

    const secret = await fastify.redis.get(`admin:2fa:setup:${admin.sub}`);
    if (!secret) {
      return reply.status(400).send({ error: "Setup 2FA expirado. Recomeça o processo." });
    }
    if (!verifyTotp(secret, code)) {
      return reply.status(400).send({ error: "Código inválido" });
    }

    await prisma.adminUser.update({ where: { id: admin.sub }, data: { twoFaSecret: sealTotpSecret(secret) } });
    await fastify.redis.del(`admin:2fa:setup:${admin.sub}`);
    await fastify.audit({
      actorType: "ADMIN",
      actorId: admin.sub,
      action: "admin.2fa.enabled",
      targetType: "AdminUser",
      targetId: admin.sub,
      ip: request.ip,
    });

    return { ok: true };
  });

  // GET /admin/auth/me
  fastify.get("/me", { preHandler }, async (request) => {
    const admin = request.adminUser!;
    const user = await prisma.adminUser.findUnique({
      where: { id: admin.sub },
      select: { id: true, name: true, email: true, role: true, twoFaSecret: true },
    });
    if (!user) throw new Error("Utilizador não encontrado");
    return { id: user.id, name: user.name, email: user.email, role: user.role, twoFaEnabled: !!user.twoFaSecret };
  });

  // POST /admin/auth/register
  fastify.post<{
    Body: { name: string; email: string; password: string; role?: string; bootstrapKey?: string };
  }>("/register", async (request, reply) => {
    const body = request.body;

    const adminCount = await prisma.adminUser.count();
    if (adminCount === 0) {
      const bootstrapKey = process.env["BOOTSTRAP_KEY"];
      if (!bootstrapKey || body.bootstrapKey !== bootstrapKey) {
        return reply.status(403).send({ error: "Bootstrap key inválida" });
      }
    } else {
      try {
        await request.jwtVerify();
        const user = request.user;
        if (user.type !== "admin" || user.role !== "SUPERADMIN") {
          return reply.status(403).send({ error: "Apenas SUPERADMIN pode criar administradores" });
        }
      } catch {
        return reply.status(401).send({ error: "Autenticação necessária" });
      }
    }

    const existing = await prisma.adminUser.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.status(409).send({ error: "Email já registado" });
    }

    const admin = await prisma.adminUser.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: (body.role as "SUPERADMIN" | "OPERATOR" | "FINANCE" | "SUPPORT") ?? "OPERATOR",
      },
    });

    await fastify.audit({
      actorType: "ADMIN",
      actorId: adminCount === 0 ? "SYSTEM" : (request.user?.sub ?? "SYSTEM"),
      action: "admin.created",
      targetType: "AdminUser",
      targetId: admin.id,
      ip: request.ip,
    });

    return { id: admin.id, email: admin.email, role: admin.role };
  });
};
