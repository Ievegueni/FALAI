import type { TicketPriority, TicketStatus } from "@falai/db";

/**
 * Cliente da API v2 do Freshdesk e conversões Falaí ↔ Freshdesk (fase 3 do
 * plano do centro de atendimento). Só HTTP e funções puras — a lógica de
 * sincronização está em sync.ts.
 *
 * API: https://<dominio>.freshdesk.com/api/v2, autenticação Basic com a API
 * key como utilizador e "X" como password.
 */

// ─── Conversões (puras) ──────────────────────────────────────────────────────

const STATUS_TO_FD: Record<TicketStatus, number> = { OPEN: 2, PENDING: 3, ON_HOLD: 3, RESOLVED: 4, CLOSED: 5 };
const PRIORITY_TO_FD: Record<TicketPriority, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };

export const toFdStatus = (s: TicketStatus) => STATUS_TO_FD[s];
export const toFdPriority = (p: TicketPriority) => PRIORITY_TO_FD[p];

/**
 * Estado do Freshdesk → Falaí. 6 e 7 são os "Waiting on Customer / Third
 * Party" que as contas novas trazem; estados personalizados desconhecidos
 * contam como em aberto.
 */
export function fromFdStatus(n: number): TicketStatus {
  return ({ 2: "OPEN", 3: "PENDING", 4: "RESOLVED", 5: "CLOSED", 6: "PENDING", 7: "ON_HOLD" } as Record<number, TicketStatus>)[n] ?? "OPEN";
}
export function fromFdPriority(n: number): TicketPriority {
  return ({ 1: "LOW", 2: "MEDIUM", 3: "HIGH", 4: "URGENT" } as Record<number, TicketPriority>)[n] ?? "MEDIUM";
}

/** Origem do ticket Falaí → "source" do Freshdesk (1 email, 2 portal, 3 telefone, 7 chat). */
export function toFdSource(source: string): number {
  if (source === "CALL") return 3;
  if (source === "EMAIL") return 1;
  if (["WHATSAPP", "WEBCHAT", "TELEGRAM"].includes(source)) return 7;
  return 2;
}
export function fromFdSource(n: number): string {
  return ({ 1: "EMAIL", 3: "CALL", 7: "WEBCHAT" } as Record<number, string>)[n] ?? "FRESHDESK";
}

/**
 * Domínio aceite. Só *.freshdesk.com — é para lá que mandamos a API key do
 * cliente, por isso não pode ser um endereço qualquer (SSRF / fuga da chave).
 * Fora de produção aceita localhost:PORTA para testes com um Freshdesk falso.
 */
export function normalizeFdDomain(input: string, production: boolean): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9][a-z0-9-]{0,62}\.freshdesk\.com$/.test(d)) return d;
  if (!production && /^(localhost|127\.0\.0\.1):\d{2,5}$/.test(d)) return d;
  return null;
}

export const fdBaseUrl = (domain: string) => `${domain.endsWith(".freshdesk.com") ? "https" : "http"}://${domain}/api/v2`;

// ─── Cliente HTTP ────────────────────────────────────────────────────────────

export class FreshdeskError extends Error {
  constructor(public status: number, message: string, public retryAfterSecs?: number) {
    super(message);
  }
}

export interface FdTicket {
  id: number;
  subject: string;
  description_text?: string;
  status: number;
  priority: number;
  source: number;
  responder_id: number | null;
  group_id: number | null;
  requester_id: number;
  created_at: string;
  updated_at: string;
  requester?: { id: number; name: string | null; email: string | null; phone: string | null; mobile: string | null };
}
export interface FdAgent { id: number; contact: { email: string | null; name: string | null } }
export interface FdGroup { id: number; name: string }

export class FreshdeskClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(domain: string, apiKey: string) {
    this.base = fdBaseUrl(domain);
    this.auth = `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error", // a chave não segue para outro sítio
    });
    if (res.status === 429) throw new FreshdeskError(429, "Limite de pedidos do Freshdesk", Number(res.headers.get("retry-after")) || 60);
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      throw new FreshdeskError(res.status, `Freshdesk ${res.status}: ${text || res.statusText}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Teste de ligação: a chave é válida e de quem é. */
  me() {
    return this.request<{ id: number; contact: { name: string; email: string } }>("GET", "/agents/me");
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 10; page++) {
      const rows = await this.request<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }
  agents() { return this.all<FdAgent>("/agents"); }
  groups() { return this.all<FdGroup>("/groups"); }

  getTicket(id: string) { return this.request<FdTicket>("GET", `/tickets/${id}?include=requester`); }
  createTicket(body: Record<string, unknown>) { return this.request<FdTicket>("POST", "/tickets", body); }
  updateTicket(id: string, body: Record<string, unknown>) { return this.request<FdTicket>("PUT", `/tickets/${id}`, body); }
  addNote(id: string, body: string) { return this.request<unknown>("POST", `/tickets/${id}/notes`, { body, private: true }); }

  /** Tickets alterados desde `since`, do mais antigo para o mais recente (100 por página). */
  updatedSince(since: Date, page: number) {
    const q = new URLSearchParams({ updated_since: since.toISOString(), order_by: "updated_at", order_type: "asc", per_page: "100", page: String(page), include: "requester" });
    return this.request<FdTicket[]>("GET", `/tickets?${q}`);
  }
}
