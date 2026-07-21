import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "@falai/db";
import { YEASTAR_EVENTS } from "@falai/shared";

/**
 * Chamadas a entrar (inbound): "screen pop" no CRM + registo ao vivo na tabela Call.
 *
 * Duas fontes alimentam este módulo, ambas com o payload cru do Yeastar:
 *   - PBX partilhado (VOICE_AI): eventos via WebSocket/webhook do Yeastar global;
 *     o tenant é resolvido pela extensão de destino (TenantLine) no toque, e pelo
 *     yeastarCallId nos eventos seguintes.
 *   - PBX próprio (CRM_BYO_PBX): eventos em /webhooks/pbx/:token — o token já
 *     identifica o tenant.
 *
 * O registo ao vivo cria um Call (kind INBOUND) no toque e actualiza-o à medida
 * que a chamada é atendida/termina, para o cliente ver a entrada de imediato —
 * sem esperar pela sincronização de CDR.
 */

// ── Hub SSE (screen pop) ─────────────────────────────────────────────────────

export interface IncomingCallPayload {
  callId: string | null;
  callerNumber: string;
  calleeNumber: string | null;
  at: string; // ISO
}

type Connection = { reply: FastifyReply };

export class IncomingCallHub {
  private connections = new Map<string, Set<Connection>>();

  subscribe(tenantId: string, reply: FastifyReply): () => void {
    let set = this.connections.get(tenantId);
    if (!set) {
      set = new Set();
      this.connections.set(tenantId, set);
    }
    const conn: Connection = { reply };
    set.add(conn);
    return () => {
      const s = this.connections.get(tenantId);
      if (!s) return;
      s.delete(conn);
      if (s.size === 0) this.connections.delete(tenantId);
    };
  }

  connectionCount(tenantId: string): number {
    return this.connections.get(tenantId)?.size ?? 0;
  }

  broadcast(tenantId: string, event: string, data: unknown): void {
    const set = this.connections.get(tenantId);
    if (!set || set.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const conn of set) {
      try {
        conn.reply.raw.write(frame);
      } catch {
        // ligação morta; limpa no evento 'close'
      }
    }
  }

  broadcastIncomingCall(tenantId: string, payload: IncomingCallPayload): void {
    this.broadcast(tenantId, "incoming-call", payload);
  }
}

// ── Parser de eventos ────────────────────────────────────────────────────────

type CallState = "RINGING" | "ANSWERED" | "ENDED" | "FAILED";

export interface ParsedCallEvent {
  callId: string;
  state: CallState | null;
  isOutbound: boolean;
  callerNumber: string | null;
  calleeNumber: string | null;
  durationSecs: number;
}

/**
 * Extrai o estado e os intervenientes de um payload cru do Yeastar. Os nomes de
 * campos variam entre firmwares, por isso lemos vários aliases e ficamos
 * permissivos. Devolve null se não houver call_id.
 */
export function parseCallEvent(raw: Record<string, unknown>): ParsedCallEvent | null {
  const callId = str(raw["call_id"]) ?? str(raw["callid"]);
  if (!callId) return null;

  const code = raw["event"] as number | undefined;
  let state: CallState | null = null;
  if (code === YEASTAR_EVENTS.CALL_STATE_CHANGED) {
    const s = str(raw["state"])?.toUpperCase();
    if (s === "RINGING") state = "RINGING";
    else if (s === "ANSWERED") state = "ANSWERED";
  } else if (code === YEASTAR_EVENTS.CALL_END) {
    state = "ENDED";
  } else if (code === YEASTAR_EVENTS.CALL_FAILURE) {
    state = "FAILED";
  } else if (code === undefined) {
    // Sem código: infere pelo campo state, se existir
    const s = str(raw["state"])?.toUpperCase();
    if (s === "RINGING") state = "RINGING";
    else if (s === "ANSWERED") state = "ANSWERED";
  }

  const callType = str(raw["call_type"]) ?? str(raw["type"]);
  const isOutbound = callType ? /out/i.test(callType) : false;

  return {
    callId,
    state,
    isOutbound,
    callerNumber:
      str(raw["call_from"]) ?? str(raw["caller"]) ?? str(raw["from"]) ?? str(raw["call_from_number"]) ?? null,
    calleeNumber:
      str(raw["call_to"]) ?? str(raw["callee"]) ?? str(raw["to"]) ?? str(raw["call_to_number"]) ?? null,
    durationSecs: numFrom(raw["duration"] ?? raw["talk_duration"]),
  };
}

// ── Ingestão (screen pop + registo ao vivo) ──────────────────────────────────

/** PBX próprio (BYO): o tenant já é conhecido pelo token do webhook. */
export async function ingestTenantPbxEvent(
  fastify: FastifyInstance,
  tenantId: string,
  raw: Record<string, unknown>
): Promise<void> {
  const ev = parseCallEvent(raw);
  if (!ev) return;
  await applyEvent(fastify, tenantId, ev);
}

/** PBX partilhado: resolve o tenant pela extensão de destino (toque) ou pelo Call existente. */
export async function ingestSharedPbxEvent(fastify: FastifyInstance, raw: Record<string, unknown>): Promise<void> {
  const ev = parseCallEvent(raw);
  if (!ev) return;

  let tenantId: string | null = null;
  if (ev.state === "RINGING" && !ev.isOutbound && ev.calleeNumber) {
    tenantId = await resolveTenantByExtension(ev.calleeNumber);
  } else {
    // Eventos seguintes: encontra o tenant pela chamada já registada
    const existing = await prisma.call.findUnique({
      where: { yeastarCallId: ev.callId },
      select: { tenantId: true },
    });
    tenantId = existing?.tenantId ?? null;
  }
  if (!tenantId) return;
  await applyEvent(fastify, tenantId, ev);
}

async function applyEvent(fastify: FastifyInstance, tenantId: string, ev: ParsedCallEvent): Promise<void> {
  switch (ev.state) {
    case "RINGING":
      if (ev.isOutbound || !ev.callerNumber) return;
      await onRinging(fastify, tenantId, ev);
      return;
    case "ANSWERED":
      await prisma.call.updateMany({
        where: { tenantId, yeastarCallId: ev.callId, kind: "INBOUND", status: "RINGING" },
        data: { status: "IN_PROGRESS", answeredAt: new Date() },
      });
      return;
    case "ENDED": {
      const call = await prisma.call.findUnique({
        where: { yeastarCallId: ev.callId },
        select: { id: true, answeredAt: true },
      });
      if (!call) return;
      await prisma.call.update({
        where: { id: call.id },
        data: {
          status: call.answeredAt ? "COMPLETED" : "NO_ANSWER",
          endedAt: new Date(),
          durationSecs: ev.durationSecs,
        },
      });
      return;
    }
    case "FAILED":
      await prisma.call.updateMany({
        where: { tenantId, yeastarCallId: ev.callId, kind: "INBOUND" },
        data: { status: "NO_ANSWER", endedAt: new Date() },
      });
      return;
    default:
      return;
  }
}

async function onRinging(fastify: FastifyInstance, tenantId: string, ev: ParsedCallEvent): Promise<void> {
  const callerNumber = ev.callerNumber!;
  const contactId = await findContactIdByPhone(tenantId, callerNumber);

  // Regista/atualiza a chamada de entrada (idempotente por yeastarCallId)
  await prisma.call.upsert({
    where: { yeastarCallId: ev.callId },
    create: {
      tenantId,
      kind: "INBOUND",
      status: "RINGING",
      fromNumber: callerNumber,
      toNumber: ev.calleeNumber ?? "",
      ...(contactId && { contactId }),
      yeastarCallId: ev.callId,
      startedAt: new Date(),
    },
    update: {}, // toque repetido: não sobrescreve
  });

  // Screen pop
  fastify.incomingCalls.broadcastIncomingCall(tenantId, {
    callId: ev.callId,
    callerNumber,
    calleeNumber: ev.calleeNumber,
    at: new Date().toISOString(),
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve o tenant dono da extensão de destino (PBX partilhado). */
export async function resolveTenantByExtension(extension: string): Promise<string | null> {
  const line = await prisma.tenantLine.findFirst({
    where: { extension, isActive: true },
    select: { tenantId: true },
  });
  return line?.tenantId ?? null;
}

/** Procura um contacto do tenant cujo telefone corresponda ao número (pelos últimos 9 dígitos). */
async function findContactIdByPhone(tenantId: string, phone: string): Promise<string | null> {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return null;
  const tail = digits.slice(-9);
  const contact = await prisma.contact.findFirst({
    where: { tenantId, phone: { contains: tail } },
    select: { id: true },
  });
  return contact?.id ?? null;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function numFrom(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
