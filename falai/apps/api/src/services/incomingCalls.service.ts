import type { FastifyInstance, FastifyReply } from "fastify";
import { prisma } from "@falai/db";
import { YEASTAR_EVENTS } from "@falai/shared";

/**
 * Chamadas a entrar (inbound): "screen pop" no CRM + registo ao vivo na tabela Call.
 *
 * Fonte: o PBX Yeastar próprio de um cliente CRM_BYO_PBX, com o payload cru em
 * /webhooks/pbx/:token — o token identifica o tenant. As chamadas do motor
 * Asterisk da plataforma entram por inboundCallRouter.service.ts.
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

// idsOnly: o agente (MEMBER) só vê as suas conversas e as da fila, por isso
// os eventos de conversa chegam-lhe só com o id — o conteúdo vem pela API,
// que aplica o âmbito (services/userScope.ts).
type Connection = { reply: FastifyReply; idsOnly: boolean; userId: string | null };

export class IncomingCallHub {
  private connections = new Map<string, Set<Connection>>();

  subscribe(tenantId: string, reply: FastifyReply, opts: { idsOnly?: boolean; userId?: string } = {}): () => void {
    let set = this.connections.get(tenantId);
    if (!set) {
      set = new Set();
      this.connections.set(tenantId, set);
    }
    const conn: Connection = { reply, idsOnly: opts.idsOnly === true, userId: opts.userId ?? null };
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

  /** Só para estes utilizadores (ex.: membros de uma conversa do chat interno). */
  sendToUsers(tenantId: string, userIds: Iterable<string>, event: string, data: unknown): void {
    const set = this.connections.get(tenantId);
    if (!set || set.size === 0) return;
    const to = new Set(userIds);
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const conn of set) {
      if (!conn.userId || !to.has(conn.userId)) continue;
      try {
        conn.reply.raw.write(frame);
      } catch {
        // ligação morta; limpa no evento 'close'
      }
    }
  }

  broadcast(tenantId: string, event: string, data: unknown): void {
    const set = this.connections.get(tenantId);
    if (!set || set.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const d = data as { conversationId?: string; conversation?: { id?: string } } | null;
    const idsFrame = event.startsWith("conversation.")
      ? `event: ${event}\ndata: ${JSON.stringify({ conversationId: d?.conversationId ?? d?.conversation?.id })}\n\n`
      : frame;
    for (const conn of set) {
      // Alertas operacionais são para supervisão, não para o agente.
      if (conn.idsOnly && event.startsWith("alert.")) continue;
      try {
        conn.reply.raw.write(conn.idsOnly ? idsFrame : frame);
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

async function applyEvent(fastify: FastifyInstance, tenantId: string, ev: ParsedCallEvent): Promise<void> {
  // Fecha o screen pop no CRM quando a chamada termina
  if (ev.state === "ENDED" || ev.state === "FAILED") {
    fastify.incomingCalls.broadcast(tenantId, "incoming-call.ended", { callId: ev.callId });
  }
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
