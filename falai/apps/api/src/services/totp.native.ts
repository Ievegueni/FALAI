import { createHmac, randomBytes } from "crypto";

// RFC 4648 — alfabeto Base32
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const str = input.toUpperCase().replace(/=+$/, "");
  const out = Buffer.alloc(Math.floor((str.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;

  for (const ch of str) {
    const pos = B32.indexOf(ch);
    if (pos === -1) throw new Error(`Carácter inválido na chave Base32: "${ch}"`);
    value = (value << 5) | pos;
    bits += 5;
    if (bits >= 8) {
      out[idx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out.subarray(0, idx);
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 0x1f] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f] ?? "";
  while (out.length % 8 !== 0) out += "=";
  return out;
}

// HOTP — RFC 4226
function hotp(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Gera um segredo TOTP aleatório em Base32 (160 bits).
 * Equivalente a otplib authenticator.generateSecret() — sem dependências.
 */
export function generateTotpSecretNative(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Gera o código TOTP actual para um dado segredo Base32 (RFC 6238).
 */
export function generateTotpNative(secret: string, stepSecs = 30): string {
  const counter = BigInt(Math.floor(Date.now() / 1000 / stepSecs));
  return hotp(base32Decode(secret), counter);
}

/**
 * Verifica um código TOTP aceitando ±window intervalos de 30s (padrão: ±1).
 * Implementação nativa — sem dependências externas.
 */
export function verifyTotpNative(secret: string, token: string, window = 1, stepSecs = 30): boolean {
  const counter = BigInt(Math.floor(Date.now() / 1000 / stepSecs));
  const buf = base32Decode(secret);
  for (let d = -window; d <= window; d++) {
    if (hotp(buf, counter + BigInt(d)) === token) return true;
  }
  return false;
}
