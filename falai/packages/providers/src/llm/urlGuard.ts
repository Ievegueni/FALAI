/**
 * Defesa anti-SSRF para endpoints de modelo trazidos pelo cliente (produto API_BYOM).
 *
 * A partir do momento em que o Falaí faz pedidos HTTP para um URL *escolhido pelo cliente*
 * — e ainda por cima no caminho de uma chamada telefónica ao vivo, a partir da nossa rede —
 * abre-se um vector clássico de SSRF: o cliente regista um endpoint que aponta para dentro
 * da nossa infraestrutura (metadata da cloud, Redis, Postgres, painéis internos) e usa-nos
 * como proxy.
 *
 * A defesa tem DUAS camadas, e são precisas as duas:
 *
 *  1. `assertSafeEndpointUrl` — validação sintáctica, antes do pedido. Apanha o ataque
 *     directo: IP literal privado, hostname interno, porta estranha, credenciais no URL.
 *     Sozinha NÃO chega: `evil.example.com` pode resolver para 169.254.169.254 e passa
 *     aqui à vontade.
 *
 *  2. `safeLookup` — validação DEPOIS da resolução de DNS, instalada como `lookup` do
 *     pedido HTTP. É o endereço devolvido por esta função que o socket usa de facto,
 *     portanto não há janela entre "validar" e "ligar" — fecha o DNS rebinding, que é
 *     o ataque realista contra a camada 1.
 *
 * Quem fizer pedidos a um URL do cliente tem de usar as duas. Ver RemoteModelAdapter.post.
 */

import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";

/** Portas de saída permitidas. Tudo o resto é recusado (evita varrimento de portas internas). */
export const ALLOWED_ENDPOINT_PORTS: readonly number[] = [443, 80, 8080, 8443];

/**
 * Hostnames recusados por sufixo (o próprio nome ou qualquer subdomínio).
 * `metadata.google.internal` já é apanhado por `.internal`, mas fica explícito por ser
 * o alvo mais visado.
 */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  "localhost",
  "internal",
  "local",
  "metadata.google.internal",
];

/** Só https, salvo excepção explícita para desenvolvimento local (ver abaixo). */
const DEFAULT_PROTOCOL = "https:";

/**
 * Permite `http:` quando `ALLOW_INSECURE_MODEL_ENDPOINTS === "true"`.
 * Serve exclusivamente para testes locais contra um modelo em `http://…` sem TLS.
 * NUNCA deve estar ligada em produção: sem TLS, o segredo de autenticação do cliente
 * e a transcrição da chamada viajam em claro.
 */
function insecureAllowed(): boolean {
  return process.env.ALLOW_INSECURE_MODEL_ENDPOINTS === "true";
}

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

/** Converte "10.0.0.1" em inteiro sem sinal; devolve null se não for IPv4 literal. */
function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Ranges IPv4 privados/reservados que nunca podem ser alvo de um endpoint de cliente. */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<{ base: string; bits: number; label: string }> = [
  { base: "0.0.0.0", bits: 8, label: "this-network (0.0.0.0/8)" },
  { base: "10.0.0.0", bits: 8, label: "rede privada (10/8)" },
  { base: "100.64.0.0", bits: 10, label: "CGNAT (100.64/10)" },
  { base: "127.0.0.0", bits: 8, label: "loopback (127/8)" },
  { base: "169.254.0.0", bits: 16, label: "link-local / metadata da cloud (169.254/16)" },
  { base: "172.16.0.0", bits: 12, label: "rede privada (172.16/12)" },
  { base: "192.168.0.0", bits: 16, label: "rede privada (192.168/16)" },
  { base: "192.0.0.0", bits: 24, label: "IETF protocol assignments (192.0.0/24)" },
  { base: "198.18.0.0", bits: 15, label: "benchmarking (198.18/15)" },
  { base: "224.0.0.0", bits: 4, label: "multicast (224/4)" },
  { base: "240.0.0.0", bits: 4, label: "reservado (240/4)" },
];

function blockedIpv4Reason(value: number): string | null {
  for (const cidr of BLOCKED_IPV4_CIDRS) {
    const base = parseIpv4(cidr.base);
    if (base === null) continue;
    const mask = cidr.bits === 0 ? 0 : (0xffffffff << (32 - cidr.bits)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) return cidr.label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

/**
 * Expande um IPv6 literal (com `::` e/ou cauda IPv4) para 16 bytes.
 * Devolve null se não for um IPv6 válido.
 */
function parseIpv6(input: string): number[] | null {
  // Descarta a zona de interface (fe80::1%en0).
  const host = input.split("%")[0] ?? "";
  if (!host.includes(":")) return null;

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  const expandGroup = (group: string): number[] | null => {
    if (group === "") return [];
    const out: number[] = [];
    const chunks = group.split(":");
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] ?? "";
      // Última posição pode ser um IPv4 embrulhado (::ffff:169.254.169.254).
      if (chunk.includes(".")) {
        if (i !== chunks.length - 1) return null;
        const v4 = parseIpv4(chunk);
        if (v4 === null) return null;
        out.push((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
      const word = Number.parseInt(chunk, 16);
      out.push((word >> 8) & 0xff, word & 0xff);
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const bytes = expandGroup(doubleColonParts[0] ?? "");
    return bytes && bytes.length === 16 ? bytes : null;
  }

  const head = expandGroup(doubleColonParts[0] ?? "");
  const tail = expandGroup(doubleColonParts[1] ?? "");
  if (head === null || tail === null) return null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function blockedIpv6Reason(bytes: number[]): string | null {
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;

  // IPv4 embrulhado em IPv6: ::ffff:a.b.c.d e ::a.b.c.d (deprecated compat).
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    const v4 = ((bytes[12] ?? 0) << 24) | ((bytes[13] ?? 0) << 16) | ((bytes[14] ?? 0) << 8) | (bytes[15] ?? 0);
    const reason = blockedIpv4Reason(v4 >>> 0);
    return reason ? `IPv4 embrulhado em IPv6 — ${reason}` : null;
  }

  const allZero = bytes.every((b) => b === 0);
  if (allZero) return "endereço não especificado (::)";

  const isLoopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (isLoopback) return "loopback (::1)";

  // fc00::/7 — unique local addresses.
  if ((b0 & 0xfe) === 0xfc) return "ULA (fc00::/7)";

  // fe80::/10 — link-local.
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return "link-local (fe80::/10)";

  // ::ffff:0:0/96 já tratado acima; restantes ::a.b.c.d (IPv4-compatible, deprecated).
  if (first10Zero) return "IPv4-compatible IPv6 (::a.b.c.d)";

  return null;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Verifica se um host literal (IPv4 ou IPv6, sem parênteses rectos) cai num range
 * proibido. Devolve o motivo (em português) ou null se for aceitável / não for IP literal.
 *
 * Exportada para poder ser reutilizada na validação pós-resolução de DNS (ver TODO no topo).
 */
export function blockedIpLiteralReason(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  const v4 = parseIpv4(bare);
  if (v4 !== null) return blockedIpv4Reason(v4);

  const v6 = parseIpv6(bare);
  if (v6 !== null) return blockedIpv6Reason(v6);

  return null;
}

/**
 * Valida o URL de inferência do cliente. Devolve o `URL` normalizado ou lança `Error`
 * com uma mensagem em português pronta a mostrar ao cliente no CRM/backoffice.
 */
export function assertSafeEndpointUrl(rawUrl: string): URL {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) {
    throw new Error("URL do modelo em falta.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`URL do modelo inválido: "${trimmed}".`);
  }

  // 1. Protocolo.
  const allowHttp = insecureAllowed();
  if (url.protocol !== DEFAULT_PROTOCOL && !(allowHttp && url.protocol === "http:")) {
    throw new Error(
      allowHttp
        ? `Protocolo "${url.protocol}" não permitido — o endpoint do modelo tem de usar https:// (ou http:// em modo de desenvolvimento).`
        : `Protocolo "${url.protocol}" não permitido — o endpoint do modelo tem de usar https://.`,
    );
  }

  // 2. Credenciais embutidas (https://user:pass@host) — fuga de segredos em logs e
  //    truque comum para disfarçar o host verdadeiro.
  if (url.username || url.password) {
    throw new Error("O URL do modelo não pode conter credenciais embutidas (user:pass@).");
  }

  // 3. Porta.
  const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  if (!ALLOWED_ENDPOINT_PORTS.includes(port)) {
    throw new Error(
      `Porta ${port} não permitida no endpoint do modelo. Portas aceites: ${ALLOWED_ENDPOINT_PORTS.join(", ")}.`,
    );
  }

  // 4. Host vazio.
  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new Error("O URL do modelo não tem host.");
  }

  // 5. IP literal em range privado/reservado.
  const ipReason = blockedIpLiteralReason(hostname);
  if (ipReason) {
    throw new Error(`Endereço interno não permitido no endpoint do modelo: ${hostname} — ${ipReason}.`);
  }

  // 6. Hostnames internos conhecidos (o próprio nome ou qualquer subdomínio).
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      throw new Error(`Host interno não permitido no endpoint do modelo: ${hostname}.`);
    }
  }

  // 7. Nome sem ponto (ex.: "redis", "postgres") — só existe dentro da rede interna.
  //    Um IP literal já foi tratado no passo 5.
  if (!hostname.includes(".") && !hostname.includes(":")) {
    throw new Error(
      `Host "${hostname}" não é um nome público qualificado — use um domínio completo (ex.: api.exemplo.com).`,
    );
  }

  return url;
}

/** Versão booleana de `assertSafeEndpointUrl`, para validação em formulários. */
export function isSafeEndpointUrl(rawUrl: string): boolean {
  try {
    assertSafeEndpointUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Camada 2 — validação pós-resolução de DNS
// ---------------------------------------------------------------------------

/** Erro atirado quando um nome resolve para um endereço interno. */
export class BlockedAddressError extends Error {
  constructor(
    readonly hostname: string,
    readonly address: string,
    reason: string,
  ) {
    super(`O host "${hostname}" resolve para um endereço interno (${address}) — ${reason}.`);
    this.name = "BlockedAddressError";
  }
}

/**
 * `lookup` para passar a `https.request`/`net.connect`. Resolve o nome e recusa a
 * ligação se ALGUM dos endereços devolvidos cair num range proibido.
 *
 * Porque é que isto fecha o rebinding: o endereço que devolvemos aqui é o endereço a
 * que o socket se liga. Não há um segundo passo em que o nome possa ser re-resolvido
 * para outra coisa — ao contrário de "resolver, validar, e depois pedir por nome", que
 * deixa o atacante trocar a resposta de DNS no meio.
 *
 * Recusamos se QUALQUER endereço for interno, não só o escolhido: um nome que devolve
 * `[1.2.3.4, 169.254.169.254]` é um ataque, mesmo que desta vez calhasse o público.
 */
export const safeLookup: LookupFunction = (hostname, options, callback): void => {
  const opts = (typeof options === "object" && options !== null ? options : {}) as Record<string, unknown>;
  const wantsAll = opts["all"] === true;

  // Resolvemos SEMPRE com all:true, mesmo quando quem chama só quer um endereço:
  // é preciso ver a lista toda para recusar um nome que devolve um público e um
  // interno à mistura.
  dnsLookup(hostname, { ...opts, all: true } as never, (err, addresses) => {
    if (err) return callback(err, "", 0);

    const list = addresses as unknown as LookupAddress[];
    if (!Array.isArray(list) || list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`Não foi possível resolver "${hostname}".`);
      e.code = "ENOTFOUND";
      return callback(e, "", 0);
    }

    for (const entry of list) {
      const reason = blockedIpLiteralReason(entry.address);
      if (reason) return callback(new BlockedAddressError(hostname, entry.address, reason), "", 0);
    }

    if (wantsAll) return callback(null, list as never, 0);

    const first = list[0]!;
    return callback(null, first.address, first.family);
  });
};

interface LookupAddress {
  address: string;
  family: number;
}
