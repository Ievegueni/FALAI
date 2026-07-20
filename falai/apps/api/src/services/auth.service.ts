import * as argon2 from "argon2";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import { prisma } from "@falai/db";
import type { FastifyInstance } from "fastify";
import type { AdminJwtPayload, TenantJwtPayload } from "../plugins/auth.js";
import { generateTotpSecretNative, generateTotpNative, verifyTotpNative } from "./totp.native.js";

// Re-exporta a implementação nativa para quem quiser usá-la directamente
export { generateTotpSecretNative, generateTotpNative, verifyTotpNative };

const TOTP_WINDOW = 1; // ±1 intervalo de 30s

authenticator.options = { window: TOTP_WINDOW };

// ── Password ──────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

// ── TOTP ─────────────────────────────────────────────────────────────────

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function verifyTotp(secret: string, token: string): boolean {
  return authenticator.verify({ token, secret });
}

export async function generateTotpQrCode(email: string, secret: string): Promise<string> {
  const otpauth = authenticator.keyuri(email, "Falaí Backoffice", secret);
  return QRCode.toDataURL(otpauth);
}

// ── JWT ──────────────────────────────────────────────────────────────────

export async function issueAdminToken(
  fastify: FastifyInstance,
  adminId: string
): Promise<string> {
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

  const payload: AdminJwtPayload = {
    sub: admin.id,
    email: admin.email,
    role: admin.role,
    type: "admin",
  };

  return fastify.jwt.sign(payload);
}

export async function issueTenantToken(
  fastify: FastifyInstance,
  tenantUserId: string
): Promise<string> {
  const tenantUser = await prisma.tenantUser.findUniqueOrThrow({
    where: { id: tenantUserId },
    include: { tenant: { select: { id: true } } },
  });

  const payload: TenantJwtPayload = {
    sub: tenantUser.id,
    tenantId: tenantUser.tenant.id,
    email: tenantUser.email,
    role: tenantUser.role,
    type: "tenant",
  };

  return fastify.jwt.sign(payload);
}

// ── Pending 2FA session (Redis-backed, 5 min TTL) ────────────────────────

export function pending2FaKey(sessionToken: string): string {
  return `admin:2fa:pending:${sessionToken}`;
}

export function pending2FaTenantKey(sessionToken: string): string {
  return `tenant:2fa:pending:${sessionToken}`;
}
