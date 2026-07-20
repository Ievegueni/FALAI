import { createHash, randomBytes } from "crypto";
import { prisma } from "@falai/db";

export const VALID_SCOPES = [
  "calls:read",
  "calls:write",
  "agents:read",
  "contacts:read",
  "contacts:write",
  "campaigns:read",
  "campaigns:write",
  "wallet:read",
  "otp:call",
] as const;

export type ApiScope = (typeof VALID_SCOPES)[number];

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const random = randomBytes(24).toString("hex"); // 48 hex chars
  const raw = `fal_live_${random}`;
  return {
    raw,
    hash: hashApiKey(raw),
    prefix: raw.slice(0, 16), // "fal_live_XXXXXXX" (shows ~7 chars of the random part)
  };
}

/** Looks up an API key by its raw value. Returns null if missing, revoked, or tenant suspended. */
export async function resolveApiKey(rawKey: string) {
  const hash = hashApiKey(rawKey);
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hash },
    include: { tenant: { select: { id: true, status: true, deletedAt: true } } },
  });

  if (!apiKey || apiKey.revokedAt) return null;
  if (!apiKey.tenant || apiKey.tenant.deletedAt) return null;
  if (apiKey.tenant.status === "SUSPENDED" || apiKey.tenant.status === "CLOSED") return null;

  // Update lastUsedAt without awaiting (fire-and-forget)
  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return apiKey;
}

export function hasScope(apiKey: { scopes: string[] }, required: string): boolean {
  return apiKey.scopes.includes(required) || apiKey.scopes.includes("*");
}
