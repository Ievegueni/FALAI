/**
 * SMS automático a quem ficou sem resposta.
 *
 * O módulo de SMS já existia por inteiro (gateway, cobrança, campanhas), mas
 * nada no projecto reagia ao resultado de uma chamada — não há motor de
 * automações. Isto é o único ponto onde uma chamada não atendida se transforma
 * numa mensagem, e é chamado de todos os sítios onde uma chamada fecha sem
 * ninguém ter atendido (que são cinco, cada um com a sua contabilidade própria).
 *
 * Três regras que valem para todos esses sítios:
 *   1. só se envia se o cliente tiver pedido (desligado por defeito) — o SMS é
 *      cobrado a ele;
 *   2. no máximo UM por número por dia, senão quem liga cinco vezes seguidas
 *      gera cinco mensagens pagas;
 *   3. falhar a enviar nunca estraga o fecho da chamada: a chamada é o
 *      principal, a mensagem é o extra.
 */
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import { sendSms } from "./sms.service.js";

export const MISSED_CALL_TRIGGER = "MISSED_CALL";

/** Uma mensagem por número por dia. Ver regra 2. */
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Um número a quem faz sentido mandar um SMS. Fica de fora a numeração interna
 * (uma extensão "201" não recebe SMS) e o chamador anónimo — mandar mensagens
 * para lá seria gastar saldo do cliente em envios que nunca chegam.
 */
export function isSmsReachable(number: string | null | undefined): boolean {
  if (!number) return false;
  const digits = number.replace(/[^\d]/g, "");
  return digits.length >= 9;
}

/** Substitui {numero} e {empresa} no template, como nas campanhas de SMS. */
export function renderMissedCallText(
  template: string,
  vars: { numero: string; empresa: string }
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = (vars as Record<string, string>)[key];
    return value === undefined ? match : value;
  });
}

export interface MissedCallParams {
  fastify: FastifyInstance;
  tenantId: string;
  /** Quem ficou sem resposta: o chamador (entrada) ou quem tentámos contactar (saída). */
  toNumber: string | null | undefined;
  /** Só para o registo — ajuda a perceber de que chamada veio a mensagem. */
  callId?: string;
  log: FastifyBaseLogger;
}

/**
 * Envia — se for caso disso — o SMS de chamada não atendida. Nunca lança.
 */
export async function notifyMissedCall(params: MissedCallParams): Promise<void> {
  const { fastify, tenantId, toNumber, callId, log } = params;
  try {
    if (!isSmsReachable(toNumber)) return;
    const to = toNumber!;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { missedCallSms: true, missedCallSmsText: true, name: true },
    });
    if (!tenant?.missedCallSms) return;

    const template = (tenant.missedCallSmsText ?? "").trim();
    if (!template) {
      log.warn({ tenantId, callId }, "missed_call_sms.no_text");
      return;
    }

    if (await sentRecently(tenantId, to)) {
      log.info({ tenantId, callId }, "missed_call_sms.skipped_cooldown");
      return;
    }

    const body = renderMissedCallText(template, { numero: to, empresa: tenant.name });
    const sent = await sendSms(fastify, tenantId, { to, body, trigger: MISSED_CALL_TRIGGER });
    log.info({ tenantId, callId, smsId: sent.id }, "missed_call_sms.sent");
  } catch (err) {
    // Saldo insuficiente, SMS não configurado, gateway em baixo — nada disto
    // pode sequer aparecer como erro da chamada.
    log.warn({ err, tenantId, callId }, "missed_call_sms.failed");
  }
}

/**
 * Já se mandou um automático para este número nas últimas 24h? Conta só os
 * automáticos: um SMS manual do operador para o mesmo número não deve calar o
 * aviso da chamada perdida.
 */
async function sentRecently(tenantId: string, toNumber: string): Promise<boolean> {
  const recent = await prisma.smsMessage.findFirst({
    where: {
      tenantId,
      toNumber,
      trigger: MISSED_CALL_TRIGGER,
      createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) },
    },
    select: { id: true },
  });
  return recent !== null;
}
