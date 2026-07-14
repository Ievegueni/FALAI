import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "crypto";
import { prisma } from "@falai/db";
import { adminLoginSchema, adminTotpSchema } from "@falai/shared";
import {
  verifyPassword,
  hashPassword,
  verifyTotp,
  generateTotpSecret,
  generateTotpQrCode,
  issueAdminToken,
  pending2FaKey,
} from "../../services/auth.service.js";

const PENDING_2FA_TTL = 5 * 60;

export const adminAuthRoutes: FastifyPluginAsync = async (fastify) => {
  const preHandler = [fastify.authenticate];

  // POST /admin/auth/login
  fastify.post("/login", async (request, reply) => {
    const body = adminLoginSchema.parse(request.body);

    const admin = await prisma.adminUser.findUnique({ where: { email: body.email } });
    if (!admin) {
      return reply.status(401).send({ error: "Credenciais inválidas" });
    }

    const passwordOk = await verifyPassword(admin.passwordHash, body.password);
    if (!passwordOk) {
      await fastify.audit({
        actorType: "ADMIN",
        actorId: admin.id,
        action: "admin.login.failed",
        targetType: "AdminUser",
        targetId: admin.id,
        ip: request.ip,
      });
      return reply.status(401).send({ error: "Credenciais inválidas" });
    }

    if (!admin.twoFaSecret) {
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
      return {
        token,
        requiresTwoFactor: false,
        user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role, twoFaEnabled: false },
      };
    }

    const sessionToken = randomBytes(32).toString("hex");
    await fastify.redis.set(pending2FaKey(sessionToken), admin.id, "EX", PENDING_2FA_TTL);
    return reply.status(200).send({ requiresTwoFactor: true, token: sessionToken });
  });

  // POST /admin/auth/2fa/verify
  fastify.post("/2fa/verify", async (request, reply) => {
    const body = adminTotpSchema.parse(request.body);

    const adminId = await fastify.redis.get(pending2FaKey(body.sessionToken));
    if (!adminId) {
      return reply.status(401).send({ error: "Sessão expirada ou inválida" });
    }

    const admin = await prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin?.twoFaSecret) {
      return reply.status(401).send({ error: "Sessão inválida" });
    }

    if (!verifyTotp(admin.twoFaSecret, body.code)) {
      return reply.status(401).send({ error: "Código 2FA inválido" });
    }

    await fastify.redis.del(pending2FaKey(body.sessionToken));
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

    await prisma.adminUser.update({ where: { id: admin.sub }, data: { twoFaSecret: secret } });
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
