/**
 * Endereço próprio de cada cliente no CRM: <subdomínio>.<TENANT_BASE_DOMAIN>
 * (ex.: credito.falai.ao). O subdomínio fica em Tenant.subdomain.
 *
 * Os domínios gerais (os antigos *.falai.comunica.ao, e admin/api do domínio
 * novo) continuam a aceitar qualquer cliente: só um subdomínio de cliente
 * prende o login a esse cliente.
 */
import { prisma } from "@falai/db";
import { config } from "../config.js";

/** Nomes que nunca podem ser de um cliente (serviços da plataforma). */
export const RESERVED_SUBDOMAINS = new Set([
  "admin", "api", "www", "mail", "smtp", "imap", "pop", "webmail", "ftp", "ns1", "ns2",
  "app", "crm", "status", "docs", "help", "suporte", "support", "static", "cdn", "dev", "staging", "test",
  "sip", "webphone", "ws", "falai", "autodiscover", "autoconfig",
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Valida o subdomínio (já em minúsculas e sem espaços). Devolve o erro, ou null se for válido. */
export function subdomainError(value: string): string | null {
  if (!LABEL.test(value)) return "Use 1 a 32 caracteres: letras minúsculas, números e hífen (não no início nem no fim)";
  if (RESERVED_SUBDOMAINS.has(value)) return `"${value}" está reservado para a plataforma`;
  return null;
}

const baseDomain = () => config.TENANT_BASE_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") || null;

/**
 * Subdomínio de cliente a partir do Host do pedido, ou null quando o pedido
 * veio por um domínio geral (ou a funcionalidade está desligada).
 * Só conta um nível: "credito.falai.ao" → "credito"; "a.b.falai.ao" → null.
 */
export function subdomainFromHost(host: string | undefined): string | null {
  const base = baseDomain();
  if (!base || !host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  if (!name.endsWith(`.${base}`)) return null;
  const label = name.slice(0, -(base.length + 1));
  if (!LABEL.test(label) || RESERVED_SUBDOMAINS.has(label)) return null;
  return label;
}

/** O pedido veio por um nome do domínio novo (cliente ou geral)? */
export function isOnBaseDomain(host: string | undefined): boolean {
  const base = baseDomain();
  if (!base || !host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return name === base || name.endsWith(`.${base}`);
}

/** URL do CRM de um cliente: o seu endereço próprio, ou o PUBLIC_CRM_URL geral. */
export function crmUrlFor(subdomain: string | null | undefined): string | null {
  const base = baseDomain();
  if (base && subdomain) return `https://${subdomain}.${base}`;
  return process.env["PUBLIC_CRM_URL"]?.replace(/\/$/, "") || null;
}

/** O mesmo que crmUrlFor, a partir do id do cliente. */
export async function crmUrlForTenant(tenantId: string): Promise<string | null> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { subdomain: true } });
  return crmUrlFor(t?.subdomain);
}
