import type { FastifyInstance } from "fastify";
import { prisma, type Inbox, type Prisma, type WaPoolStatus } from "@falai/db";
import { whatsappApi, inboxSecret, WhatsappApiError } from "./textChannels.service.js";
import { tenantHasFeature } from "./features.js";

/**
 * Pool Active/Standby dos números WhatsApp de um tenant — ver
 * docs/WHATSAPP-ACTIVE-STANDBY.md. O link público serve sempre o número em
 * serviço (ACTIVE/DEGRADED); o health check e os sinais da Meta decidem quando
 * trocar. Toda a troca passa por withPoolLock (um tenant de cada vez) e o
 * índice parcial "Inbox_one_active_wa" garante um só número em serviço.
 */

export type Verdict = "ok" | "warn" | "ignore" | "suspect" | "fatal";

export const FAIL_THRESHOLD = 3;
const CHECK_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 2_000;
const IN_SERVICE: WaPoolStatus[] = ["ACTIVE", "DEGRADED"];

// Valores de `status` do nó PhoneNumber da Graph API. Confirmar na doc da Meta ao subir de versão.
const STATUS_VERDICT: Record<string, Verdict> = {
  CONNECTED: "ok",
  FLAGGED: "warn", // qualidade baixa, mas ainda funciona
  BANNED: "fatal",
  DELETED: "fatal",
  DISCONNECTED: "fatal",
  RESTRICTED: "suspect",
  RATE_LIMITED: "suspect",
  MIGRATED: "suspect",
  PENDING: "suspect",
  UNVERIFIED: "suspect",
};

// Códigos de erro da Meta que dizem respeito ao próprio número. Tudo o resto
// (rede, 5xx, token 190, rate limit global, erros do destinatário) é "ignore":
// não é do número, trocar não resolvia e só criava efeito dominó.
const FATAL_CODES = new Set([131031]); // conta bloqueada
const SUSPECT_CODES = new Set([368, 131048, 133010]); // bloqueio temporário, spam rate limit, número não registado

export function classifyStatus(status: string | undefined): Verdict {
  return (status && STATUS_VERDICT[status]) || "ignore";
}

export function classifyError(err: unknown): Verdict {
  if (!(err instanceof WhatsappApiError) || err.code === null) return "ignore";
  if (FATAL_CODES.has(err.code)) return "fatal";
  if (SUSPECT_CODES.has(err.code)) return "suspect";
  return "ignore";
}

async function probe(inbox: Inbox): Promise<{ verdict: Verdict; detail: string }> {
  const token = inboxSecret(inbox, "accessToken");
  const phoneNumberId = (inbox.config as { phoneNumberId?: string }).phoneNumberId;
  if (!token || !phoneNumberId) return { verdict: "ignore", detail: "Sem accessToken/phoneNumberId" };
  try {
    const info = (await whatsappApi(token, `${phoneNumberId}?fields=status,quality_rating,name_status`)) as {
      status?: string;
      quality_rating?: string;
      name_status?: string;
    };
    const verdict = classifyStatus(info.status);
    const detail = `status=${info.status ?? "?"} quality=${info.quality_rating ?? "?"} name=${info.name_status ?? "?"}`;
    // CONNECTED com qualidade vermelha: continua a funcionar, fica o aviso.
    return { verdict: verdict === "ok" && info.quality_rating === "RED" ? "warn" : verdict, detail };
  } catch (err) {
    return { verdict: classifyError(err), detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Serializa as trocas de estado de um tenant (entre pedidos e entre instâncias da API). */
function withPoolLock<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"wa-pool:" + tenantId}))`;
    return fn(tx);
  });
}

const poolWhere = (tenantId: string) => ({ tenantId, channel: "WHATSAPP" as const, deletedAt: null });

/**
 * Garante que há um número em serviço. Com `demote`, tira primeiro esse número
 * (para o estado indicado) e, se era o que estava em serviço, promove o
 * seguinte. Devolve o número em serviço no fim (null = nenhum elegível).
 */
async function ensureActiveTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  demote?: { id: string; to: WaPoolStatus; reason?: string }
): Promise<{ current: Inbox | null; promoted: Inbox | null; demoted: Inbox | null }> {
  const now = new Date();
  let current = await tx.inbox.findFirst({ where: { ...poolWhere(tenantId), waStatus: { in: IN_SERVICE } } });
  let demoted: Inbox | null = null;

  if (demote) {
    const target = await tx.inbox.findFirst({ where: { ...poolWhere(tenantId), id: demote.id } });
    if (target && target.waStatus !== demote.to) {
      demoted = await tx.inbox.update({
        where: { id: target.id },
        data: { waStatus: demote.to, waStatusAt: now, ...(demote.reason && { waLastError: demote.reason }) },
      });
      if (current?.id === target.id) current = null;
    }
  }
  // Em serviço mas desligado no CRM: volta a standby (não é elegível enquanto estiver desligado).
  if (current && !current.enabled) {
    demoted = await tx.inbox.update({ where: { id: current.id }, data: { waStatus: "STANDBY", waStatusAt: now } });
    current = null;
  }
  if (current) return { current, promoted: null, demoted };

  // Despromover antes de promover (acima) — o índice parcial nunca é violado.
  const next = await tx.inbox.findFirst({
    where: { ...poolWhere(tenantId), enabled: true, waStatus: "STANDBY", ...(demote && { id: { not: demote.id } }) },
    orderBy: [{ waFailCount: "asc" }, { waPriority: "asc" }],
  });
  if (!next) return { current: null, promoted: null, demoted };
  const promoted = await tx.inbox.update({ where: { id: next.id }, data: { waStatus: "ACTIVE", waStatusAt: now } });
  return { current: promoted, promoted, demoted };
}

async function notify(
  fastify: FastifyInstance,
  tenantId: string,
  r: { promoted: Inbox | null; demoted: Inbox | null; current: Inbox | null },
  actor: string
) {
  if (!r.promoted && !r.demoted) return;
  const standbyLeft = await prisma.inbox.count({ where: { ...poolWhere(tenantId), enabled: true, waStatus: "STANDBY" } });
  const name = (i: Inbox | null) => (i ? `${i.name} (${(i.config as { displayPhone?: string }).displayPhone ?? "?"})` : "nenhum");
  const message = !r.current
    ? `WhatsApp: nenhum número disponível — o botão do site está sem destino (${name(r.demoted)} saiu).`
    : r.promoted
      ? `WhatsApp: número em serviço passou de ${name(r.demoted)} para ${name(r.current)}. Standby restantes: ${standbyLeft}.`
      : `WhatsApp: ${name(r.demoted)} passou a ${r.demoted!.waStatus}. Standby restantes: ${standbyLeft}.`;
  const severity = !r.current || standbyLeft === 0 ? "ERROR" : actor === "system" ? "WARNING" : "INFO";
  await prisma.systemEvent
    .create({
      data: {
        severity,
        source: "whatsapp-pool",
        tenantId,
        message,
        payload: { from: r.demoted?.id ?? null, to: r.current?.id ?? null, reason: r.demoted?.waLastError ?? null, actor },
      },
    })
    .catch(() => {});
  fastify.incomingCalls.broadcast(tenantId, "wa.pool", { message, activeId: r.current?.id ?? null });
  await fastify
    .audit({
      actorType: actor === "system" ? "SYSTEM" : "TENANT_USER",
      actorId: actor,
      tenantId,
      action: "whatsapp.pool.switch",
      targetType: "Inbox",
      targetId: r.current?.id ?? r.demoted?.id ?? "",
      before: { activeId: r.demoted?.id ?? null },
      after: { activeId: r.current?.id ?? null },
    })
    .catch(() => {});
}

/** Número para o link público. Sem ninguém em serviço, promove o primeiro standby. */
export async function resolveActive(fastify: FastifyInstance, tenantId: string): Promise<Inbox | null> {
  const current = await prisma.inbox.findFirst({ where: { ...poolWhere(tenantId), enabled: true, waStatus: { in: IN_SERVICE } } });
  if (current) return current;
  const r = await withPoolLock(tenantId, (tx) => ensureActiveTx(tx, tenantId));
  await notify(fastify, tenantId, r, "system");
  return r.current;
}

/** Acções manuais do admin (CRM). */
export async function setPoolStatus(fastify: FastifyInstance, tenantId: string, inboxId: string, to: "ACTIVE" | "STANDBY" | "DISABLED", actor: string) {
  const r = await withPoolLock(tenantId, async (tx) => {
    if (to !== "ACTIVE") return ensureActiveTx(tx, tenantId, { id: inboxId, to });
    // Activar: o actual vai para standby e este entra em serviço.
    const current = await tx.inbox.findFirst({ where: { ...poolWhere(tenantId), waStatus: { in: IN_SERVICE } } });
    if (current?.id === inboxId) return { current, promoted: null, demoted: null };
    const now = new Date();
    const demoted = current ? await tx.inbox.update({ where: { id: current.id }, data: { waStatus: "STANDBY", waStatusAt: now } }) : null;
    const promoted = await tx.inbox.update({ where: { id: inboxId }, data: { waStatus: "ACTIVE", waStatusAt: now, waFailCount: 0 } });
    return { current: promoted, promoted, demoted };
  });
  // Repor um FAILED em standby limpa o contador.
  if (to === "STANDBY") await prisma.inbox.update({ where: { id: inboxId }, data: { waFailCount: 0 } });
  await notify(fastify, tenantId, r, actor);
}

/** Depois de criar/apagar/ligar/desligar um número: repõe o invariante "há um em serviço". */
export async function reconcilePool(fastify: FastifyInstance, tenantId: string) {
  const r = await withPoolLock(tenantId, (tx) => ensureActiveTx(tx, tenantId));
  await notify(fastify, tenantId, r, "system");
}

/**
 * Health check de um número + circuit breaker. Um mau resultado só conta
 * depois de repetido (retry); FAILED só com sinal fatal ou FAIL_THRESHOLD
 * suspeitos seguidos. Devolve o veredicto final.
 */
export async function checkNumber(fastify: FastifyInstance, inboxId: string): Promise<{ verdict: Verdict; detail: string }> {
  let inbox = await prisma.inbox.findFirst({ where: { id: inboxId, channel: "WHATSAPP", deletedAt: null } });
  if (!inbox) return { verdict: "ignore", detail: "Inbox não encontrado" };
  let result = await probe(inbox);
  if (result.verdict === "suspect" || result.verdict === "fatal") {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    result = await probe(inbox);
  }
  const { verdict, detail } = result;
  const base = { waLastCheckAt: new Date(), ...(verdict !== "ok" && { waLastError: detail }) };

  if (verdict === "ok") {
    await prisma.inbox.update({ where: { id: inbox.id }, data: { ...base, waFailCount: 0 } });
    await prisma.inbox.updateMany({ where: { id: inbox.id, waStatus: "DEGRADED" }, data: { waStatus: "ACTIVE", waStatusAt: new Date() } });
    return result;
  }
  if (verdict === "warn" || verdict === "ignore") {
    await prisma.inbox.update({ where: { id: inbox.id }, data: base });
    if (verdict === "ignore") fastify.log.warn({ inboxId, detail }, "whatsapp.pool.check_inconclusive");
    return result;
  }

  inbox = await prisma.inbox.update({ where: { id: inbox.id }, data: { ...base, waFailCount: { increment: 1 } } });
  if (inbox.waStatus === "FAILED" || inbox.waStatus === "DISABLED" || inbox.waStatus === null) return result;

  if (verdict === "fatal" || inbox.waFailCount >= FAIL_THRESHOLD) {
    fastify.log.error({ inboxId, detail, failCount: inbox.waFailCount }, "whatsapp.pool.failed");
    const r = await withPoolLock(inbox.tenantId, (tx) => ensureActiveTx(tx, inbox!.tenantId, { id: inbox!.id, to: "FAILED", reason: detail }));
    await notify(fastify, inbox.tenantId, r, "system");
  } else if (inbox.waStatus === "ACTIVE") {
    await prisma.inbox.updateMany({ where: { id: inbox.id, waStatus: "ACTIVE" }, data: { waStatus: "DEGRADED", waStatusAt: new Date() } });
  }
  return result;
}

/** Verifica já todos os números do pool de um tenant (ex.: a Meta avisou por webhook). */
export async function checkTenantPool(fastify: FastifyInstance, tenantId: string) {
  const inboxes = await prisma.inbox.findMany({
    where: { ...poolWhere(tenantId), enabled: true, waStatus: { in: [...IN_SERVICE, "STANDBY"] } },
    select: { id: true },
  });
  for (const i of inboxes) await checkNumber(fastify, i.id);
}

/** Health check periódico de todos os números em pool (incluindo standby). */
export function startWaHealthCheck(fastify: FastifyInstance): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const inboxes = await prisma.inbox.findMany({
        where: { channel: "WHATSAPP", enabled: true, deletedAt: null, waStatus: { in: [...IN_SERVICE, "STANDBY"] } },
        select: { id: true, tenantId: true },
      });
      for (const i of inboxes) {
        if (!(await tenantHasFeature(i.tenantId, "inbox"))) continue;
        await checkNumber(fastify, i.id).catch((err) => fastify.log.warn({ err, inboxId: i.id }, "whatsapp.pool.check_error"));
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
