/**
 * Allowlist de IPs para chaves de API.
 *
 * Usado pelo produto API_BYOM: o cliente liga-se de máquina a máquina, a partir
 * de IPs fixos conhecidos. A chave sozinha não chega — tem de vir do sítio
 * certo. Uma chave sem `allowedCidrs` continua a aceitar qualquer origem
 * (comportamento actual, para não partir integrações existentes).
 *
 * Sem dependências externas de propósito: são ~100 linhas e evita mais uma
 * biblioteca no caminho de autenticação.
 */

import { isIP } from "net";

export interface CidrBlock {
  base: bigint;
  bits: number;
  family: 4 | 6;
}

/**
 * Normaliza um IP tal como chega do Fastify.
 *
 * Trata dois casos que dão falsos negativos silenciosos:
 *  - zona de interface IPv6 (`fe80::1%en0`)
 *  - IPv4 embrulhado em IPv6 (`::ffff:102.130.202.155`), que é o que o Node
 *    devolve num socket dual-stack — sem isto, um IPv4 na lista nunca casava.
 */
export function normalizeIp(raw: string): string | null {
  let ip = raw.trim();
  if (ip === "") return null;

  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;

  return isIP(ip) === 0 ? null : ip;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Expande "::" e converte a cauda IPv4 ("::ffff:1.2.3.4") para dois grupos.
  let head = ip;
  let tail = "";
  const doubleColon = ip.indexOf("::");
  if (doubleColon !== -1) {
    head = ip.slice(0, doubleColon);
    tail = ip.slice(doubleColon + 2);
  }

  const toGroups = (segment: string): string[] | null => {
    if (segment === "") return [];
    const groups: string[] = [];
    for (const piece of segment.split(":")) {
      if (piece.includes(".")) {
        const v4 = ipv4ToBigInt(piece);
        if (v4 === null) return null;
        groups.push(((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(piece);
    }
    return groups;
  };

  const headGroups = toGroups(head);
  const tailGroups = toGroups(tail);
  if (!headGroups || !tailGroups) return null;

  const missing = 8 - headGroups.length - tailGroups.length;
  if (doubleColon === -1) {
    if (missing !== 0) return null;
  } else if (missing < 0) {
    return null;
  }

  const all = [...headGroups, ...Array(Math.max(missing, 0)).fill("0"), ...tailGroups];
  if (all.length !== 8) return null;

  let out = 0n;
  for (const group of all) out = (out << 16n) | BigInt(parseInt(group, 16));
  return out;
}

export function ipToBigInt(ip: string): { value: bigint; family: 4 | 6 } | null {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToBigInt(ip);
    return value === null ? null : { value, family: 4 };
  }
  if (family === 6) {
    const value = ipv6ToBigInt(ip);
    return value === null ? null : { value, family: 6 };
  }
  return null;
}

/**
 * Interpreta uma entrada da allowlist. Aceita um IP solto (vira /32 ou /128)
 * ou notação CIDR. Devolve null se for inválida — quem chama decide se recusa
 * (na escrita) ou se ignora (na verificação).
 */
export function parseCidr(entry: string): CidrBlock | null {
  const [rawIp, rawBits] = entry.trim().split("/");
  const ip = normalizeIp(rawIp ?? "");
  if (!ip) return null;

  const parsed = ipToBigInt(ip);
  if (!parsed) return null;

  const maxBits = parsed.family === 4 ? 32 : 128;
  let bits = maxBits;
  if (rawBits !== undefined) {
    if (!/^\d{1,3}$/.test(rawBits)) return null;
    bits = Number(rawBits);
    if (bits > maxBits) return null;
  }

  // Zera os bits fora do prefixo, para que "10.0.0.7/8" funcione como "10.0.0.0/8".
  const hostBits = BigInt(maxBits - bits);
  const base = bits === 0 ? 0n : (parsed.value >> hostBits) << hostBits;

  return { base, bits, family: parsed.family };
}

export function isValidCidr(entry: string): boolean {
  return parseCidr(entry) !== null;
}

/** True se o IP pertencer a pelo menos um dos blocos. Lista vazia = sem restrição. */
export function ipMatchesAllowlist(rawIp: string | undefined, allowedCidrs: string[]): boolean {
  if (allowedCidrs.length === 0) return true;

  const ip = normalizeIp(rawIp ?? "");
  if (!ip) return false;

  const parsed = ipToBigInt(ip);
  if (!parsed) return false;

  const maxBits = parsed.family === 4 ? 32 : 128;

  for (const entry of allowedCidrs) {
    const block = parseCidr(entry);
    if (!block || block.family !== parsed.family) continue;
    const hostBits = BigInt(maxBits - block.bits);
    const masked = block.bits === 0 ? 0n : (parsed.value >> hostBits) << hostBits;
    if (masked === block.base) return true;
  }

  return false;
}
