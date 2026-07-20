import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Deriva sempre uma chave de 32 bytes para o AES-256-GCM.
 * Retrocompatível: uma chave que já ocupe exactamente 32 bytes em UTF-8 é usada
 * tal como antes (mantém decifráveis os segredos já guardados); qualquer outra é
 * normalizada via SHA-256, evitando que caracteres multibyte partam o cipher.
 */
function getKey(): Buffer {
  const raw = Buffer.from(config.ENCRYPTION_KEY, "utf8");
  return raw.length === 32 ? raw : createHash("sha256").update(raw).digest();
}

// Encripta um valor de secret para guardar em SystemSetting
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Formato: iv(12) + authTag(16) + ciphertext, tudo em base64
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted) + decipher.final("utf8");
}

// Máscara para exibição na UI (mostra prefixo e asteriscos)
export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}
