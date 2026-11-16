import * as argon2 from "argon2";
import { randomUUID } from "crypto";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import { prisma } from "@falai/db";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import { encryptSecret, decryptSecret } from "./crypto.service.js";
import type { AdminJwtPayload, TenantJwtPayload } from "../plugins/auth.js";
import { generateTotpSecretNative, generateTotpNative, verifyTotpNative } from "./totp.native.js";

// Re-exporta a implementação nativa para quem quiser usá-la directamente
export { generateTotpSecretNative, generateTotpNative, verifyTotpNative };

const TOTP_WINDOW = 1; // ±1 intervalo de 30s

authenticator.options = { window: TOTP_WINDOW };

// ── Password ──────────────────────────────────────────────────────────────

// Passwords mais usadas (inclui as típicas cá). Lista curta de propósito:
// apanha o grosso dos ataques de dicionário sem obrigar a regras chatas.
const COMMON_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000", "12341234",
  "password", "password1", "password123", "passw0rd", "qwerty123", "qwertyuiop", "abc12345",
  "iloveyou", "welcome1", "admin123", "administrador", "letmein1", "senha123", "senha1234",
  "palavrapasse", "angola123", "angola2025", "angola2026", "luanda123", "luanda2026",
  "falai123", "falai2025", "falai2026", "comunica123", "comunica2026", "mudar123", "teste123",
]);

/** Motivo para recusar a password, ou null se serve. */
export function weakPasswordReason(password: string): string | null {
  if (password.length < 8) return "A password tem de ter pelo menos 8 caracteres";
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "Essa password é demasiado comum. Escolha outra.";
  if (/^\d+$/.test(password)) return "A password não pode ter só números";
  if (/^(.)\1+$/.test(password)) return "A password não pode ser o mesmo carácter repetido";
  return null;
}

// Todos os sítios que definem uma password passam por aqui: a regra fica num só lugar.
// ZodError para o error handler devolver 400 com a mensagem.
export async function hashPassword(password: string): Promise<string> {
  const reason = weakPasswordReason(password);
  if (reason) throw new ZodError([{ code: "custom", message: reason, path: ["password"] }]);
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

// Hash descartável: com email inexistente verifica-se na mesma, para a resposta
// demorar o mesmo e não denunciar que emails existem.
let dummyHash: Promise<string> | undefined;
export async function verifyPasswordOrDummy(hash: string | undefined, password: string): Promise<boolean> {
  if (hash) return verifyPassword(hash, password);
  dummyHash ??= argon2.hash(randomUUID(), { type: argon2.argon2id });
  await argon2.verify(await dummyHash, password);
  return false;
}

// ── Bloqueio por conta ─────────────────────────────────────────────────────
// O rate-limit do login é por IP: não trava quem roda IPs e penaliza escritórios
// atrás do mesmo NAT. Isto conta falhas por email, venha de onde vier.

const MAX_LOGIN_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;
const failKey = (kind: "admin" | "tenant", email: string) => `login:fail:${kind}:${email.toLowerCase()}`;

export async function isLoginLocked(redis: Redis, kind: "admin" | "tenant", email: string): Promise<boolean> {
  return Number(await redis.get(failKey(kind, email))) >= MAX_LOGIN_FAILURES;
}

export async function recordLoginFailure(redis: Redis, kind: "admin" | "tenant", email: string): Promise<void> {
  const key = failKey(kind, email);
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, LOCK_SECONDS);
}

export async function clearLoginFailures(redis: Redis, kind: "admin" | "tenant", email: string): Promise<void> {
  await redis.del(failKey(kind, email));
}

export const LOCKED_MESSAGE = "Demasiadas tentativas falhadas. A conta fica bloqueada 15 minutos.";

// ── TOTP ─────────────────────────────────────────────────────────────────

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function verifyTotp(secret: string, token: string): boolean {
  return authenticator.verify({ token, secret });
}

// O segredo TOTP fica cifrado na BD. Os antigos (base32 em claro) continuam a
// ler-se; encryptLegacyTotpSecrets cifra-os no arranque da API.
const isPlainTotp = (stored: string) => /^[A-Z2-7]+=*$/.test(stored);
export const sealTotpSecret = (secret: string) => encryptSecret(secret);
export const openTotpSecret = (stored: string) => (isPlainTotp(stored) ? stored : decryptSecret(stored));

/**
 * Verifica o código e impede que o mesmo código sirva duas vezes (vale ~90s
 * com a janela de ±1). `who` identifica o utilizador, ex. "tenant:<id>".
 */
export async function verifyTotpOnce(redis: Redis, who: string, storedSecret: string, code: string): Promise<boolean> {
  if (!verifyTotp(openTotpSecret(storedSecret), code)) return false;
  const fresh = await redis.set(`totp:used:${who}:${code}`, "1", "EX", 120, "NX");
  return fresh === "OK";
}

export async function encryptLegacyTotpSecrets(): Promise<number> {
  const where = { twoFaSecret: { not: null } };
  const select = { id: true, twoFaSecret: true };
  const tenants = (await prisma.tenantUser.findMany({ where, select })).filter((r) => isPlainTotp(r.twoFaSecret!));
  const admins = (await prisma.adminUser.findMany({ where, select })).filter((r) => isPlainTotp(r.twoFaSecret!));
  for (const r of tenants) await prisma.tenantUser.update({ where: { id: r.id }, data: { twoFaSecret: sealTotpSecret(r.twoFaSecret!) } });
  for (const r of admins) await prisma.adminUser.update({ where: { id: r.id }, data: { twoFaSecret: sealTotpSecret(r.twoFaSecret!) } });
  return tenants.length + admins.length;
}

// ── Sessão de 2FA pendente (entre a password e o código) ──────────────────
// Guarda o utilizador e, se ainda não tem 2FA e ela é obrigatória, o segredo
// novo a confirmar. Máximo de tentativas por sessão: depois é preciso a password outra vez.

const PENDING_2FA_TTL = 5 * 60;
const MAX_2FA_TRIES = 5;

export interface Pending2Fa { userId: string; enrollSecret?: string }

export async function createPending2Fa(redis: Redis, key: string, data: Pending2Fa): Promise<void> {
  await redis.set(key, JSON.stringify(data), "EX", PENDING_2FA_TTL);
}

/** Lê a sessão pendente e conta a tentativa; null se expirou ou esgotou tentativas. */
export async function takePending2FaAttempt(redis: Redis, key: string): Promise<Pending2Fa | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  const tries = await redis.incr(`${key}:tries`);
  if (tries === 1) await redis.expire(`${key}:tries`, PENDING_2FA_TTL);
  if (tries > MAX_2FA_TRIES) {
    await redis.del(key, `${key}:tries`);
    return null;
  }
  return JSON.parse(raw) as Pending2Fa;
}

export async function endPending2Fa(redis: Redis, key: string): Promise<void> {
  await redis.del(key, `${key}:tries`);
}

/** 2FA obrigatória: todos os admins do backoffice e o OWNER de cada cliente. */
export const tenantRoleRequires2Fa = (role: string) => role === "OWNER";

export async function generateTotpQrCode(email: string, secret: string, issuer = "Falaí Backoffice"): Promise<string> {
  const otpauth = authenticator.keyuri(email, issuer, secret);
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
    tv: admin.tokenVersion,
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
    tv: tenantUser.tokenVersion,
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
