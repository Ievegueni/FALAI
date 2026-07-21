import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import type { YeastarCdrRecord } from "@falai/providers";
import { getTenantTelephony, hasOwnPbx } from "./tenantTelephony.service.js";

/**
 * Sincroniza o CDR (histórico de chamadas) do PBX próprio de um tenant CRM_BYO_PBX
 * para a tabela PbxCall, para alimentar a lista de Chamadas e o dashboard do CRM.
 */

const SYNC_THROTTLE_MS = 30_000; // evita bater no PBX a cada carregamento

interface TenantPbxInfo {
  plan: { productType: string };
  pbxBaseUrl: string | null;
  pbxClientId: string | null;
  pbxClientSecret: string | null;
  pbxLastSyncAt: Date | null;
}

/** Converte o campo de tempo do CDR num Date. Prefere epoch; senão faz parse de "YYYY/MM/DD HH:mm:ss". */
function parseCdrTime(rec: YeastarCdrRecord): Date {
  if (rec.timestamp !== undefined && rec.timestamp !== null && rec.timestamp !== "") {
    const epoch = Number(rec.timestamp);
    if (!Number.isNaN(epoch)) return new Date(epoch * 1000);
  }
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(rec.time ?? "");
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  return new Date();
}

function num(v: number | undefined): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

/**
 * Garante que o CDR do tenant está sincronizado (respeitando o throttle) e devolve
 * se o tenant é CRM (BYO-PBX). Se não for, não faz nada.
 */
export async function ensureCdrSynced(
  fastify: FastifyInstance,
  tenantId: string,
  opts?: { force?: boolean }
): Promise<{ isCrmPbx: boolean }> {
  const tenant = (await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      pbxBaseUrl: true,
      pbxClientId: true,
      pbxClientSecret: true,
      pbxLastSyncAt: true,
      plan: { select: { productType: true } },
    },
  })) as TenantPbxInfo | null;

  if (!tenant || !hasOwnPbx(tenant)) return { isCrmPbx: false };

  const fresh = tenant.pbxLastSyncAt && Date.now() - tenant.pbxLastSyncAt.getTime() < SYNC_THROTTLE_MS;
  if (fresh && !opts?.force) return { isCrmPbx: true };

  try {
    const adapter = await getTenantTelephony(fastify, tenantId);
    const { records } = await adapter.getCdr({ page: 1, pageSize: 200 });
    await upsertRecords(tenantId, records);
    await prisma.tenant.update({ where: { id: tenantId }, data: { pbxLastSyncAt: new Date() } });
  } catch (err) {
    fastify.log.warn({ err, tenantId }, "pbx_cdr.sync_failed");
  }
  return { isCrmPbx: true };
}

// Debounce em memória para os webhooks (coalesce de rajadas de eventos por tenant)
const webhookDebounce = new Map<string, number>();
const WEBHOOK_DEBOUNCE_MS = 4_000;

/**
 * Sincroniza o CDR em resposta a um evento de webhook do PBX do tenant.
 * Faz debounce para não bater no PBX a cada evento de uma rajada.
 */
export async function syncCdrOnWebhook(fastify: FastifyInstance, tenantId: string): Promise<void> {
  const last = webhookDebounce.get(tenantId);
  if (last && Date.now() - last < WEBHOOK_DEBOUNCE_MS) return;
  webhookDebounce.set(tenantId, Date.now());
  try {
    const adapter = await getTenantTelephony(fastify, tenantId);
    const { records } = await adapter.getCdr({ page: 1, pageSize: 50 });
    await upsertRecords(tenantId, records);
    await prisma.tenant.update({ where: { id: tenantId }, data: { pbxLastSyncAt: new Date() } });
  } catch (err) {
    fastify.log.warn({ err, tenantId }, "pbx_cdr.webhook_sync_failed");
  }
}

async function upsertRecords(tenantId: string, records: YeastarCdrRecord[]): Promise<void> {
  await Promise.all(
    records
      .filter((r) => r.uid)
      .map((r) => {
        const data = {
          callType: r.call_type ?? "Outbound",
          disposition: r.disposition ?? "FAILED",
          fromNumber: r.call_from_number ?? r.call_from ?? "",
          toNumber: r.call_to_number ?? r.call_to ?? "",
          fromName: r.call_from ?? null,
          toName: r.call_to ?? null,
          durationSecs: num(r.duration),
          ringSecs: num(r.ring_duration),
          talkSecs: num(r.talk_duration),
          recordFile: r.record_file ?? null,
          startedAt: parseCdrTime(r),
        };
        return prisma.pbxCall.upsert({
          where: { tenantId_uid: { tenantId, uid: r.uid! } },
          create: { tenantId, uid: r.uid!, ...data },
          update: data,
        });
      })
  );

  // Registos "ao vivo" de entrada já terminados passam a ser cobertos pelo CDR
  // (fonte autoritativa) — remove-os para não duplicar na lista do CRM.
  await prisma.call.deleteMany({
    where: { tenantId, kind: "INBOUND", status: { notIn: ["RINGING", "IN_PROGRESS"] } },
  });
}

/** Registos de entrada ainda em curso (toque/em conversa), para fundir na lista/dashboard BYO-PBX. */
export async function activeInboundCalls(tenantId: string) {
  return prisma.call.findMany({
    where: { tenantId, kind: "INBOUND", status: { in: ["RINGING", "IN_PROGRESS"] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, agentId: true, kind: true, contactId: true, toNumber: true, fromNumber: true, status: true,
      outcome: true, durationSecs: true, costCents: true, startedAt: true, endedAt: true, createdAt: true,
      agent: { select: { name: true } },
      contact: { select: { name: true } },
    },
  });
}

// ── Mapeamento para o shape de Call que o CRM consome ────────────────────────

type PbxCallRow = {
  id: string;
  uid: string;
  callType: string;
  disposition: string;
  fromNumber: string;
  toNumber: string;
  fromName: string | null;
  toName: string | null;
  durationSecs: number;
  talkSecs: number;
  startedAt: Date;
};

const DISPOSITION_TO_STATUS: Record<string, string> = {
  ANSWERED: "COMPLETED",
  "NO ANSWER": "NO_ANSWER",
  NO_ANSWER: "NO_ANSWER",
  BUSY: "FAILED",
  FAILED: "FAILED",
  VOICEMAIL: "COMPLETED",
};

const DIRECTION_LABEL: Record<string, string> = {
  Inbound: "Entrada",
  Outbound: "Saída",
  Internal: "Interna",
};

export function pbxCallStatus(disposition: string): string {
  return DISPOSITION_TO_STATUS[disposition.toUpperCase()] ?? DISPOSITION_TO_STATUS[disposition] ?? "FAILED";
}

/** O "outro interveniente" (número externo) consoante a direção. */
function otherParty(c: PbxCallRow): string {
  return c.callType === "Inbound" ? c.fromNumber : c.toNumber;
}

const DIRECTION_KEY: Record<string, string> = {
  Inbound: "inbound",
  Outbound: "outbound",
  Internal: "internal",
};

export function mapPbxCall(c: PbxCallRow) {
  return {
    id: c.id,
    agentId: "",
    direction: DIRECTION_KEY[c.callType] ?? "outbound",
    contactId: null,
    to: otherParty(c),
    from: c.fromNumber,
    party: otherParty(c),
    status: pbxCallStatus(c.disposition),
    outcome: c.disposition,
    durationSecs: c.talkSecs || c.durationSecs,
    costCents: 0,
    startedAt: c.startedAt,
    endedAt: null,
    createdAt: c.startedAt,
    recordingUrl: null,
    // Reusa a coluna "Agente" para mostrar a direção da chamada (não há agente em BYO-PBX)
    agent: { name: DIRECTION_LABEL[c.callType] ?? c.callType },
    contact: null,
  };
}

export const PBX_CALL_SELECT = {
  id: true,
  uid: true,
  callType: true,
  disposition: true,
  fromNumber: true,
  toNumber: true,
  fromName: true,
  toName: true,
  durationSecs: true,
  talkSecs: true,
  startedAt: true,
} as const;
