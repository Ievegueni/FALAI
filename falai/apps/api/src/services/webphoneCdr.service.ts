/**
 * Contabilização das chamadas marcadas NO TELEFONE (webphone ou hardphone).
 *
 * PORQUÊ ESTE FICHEIRO EXISTE
 * Uma chamada feita pelo teclado do webphone não passa pela API: o softphone
 * manda o INVITE directamente ao Asterisk, que a encaminha pelo dialplan
 * ([from-internal] → sair → trunk). Só as chamadas originadas pelo CRM
 * (click-to-call) criavam registo. Resultado: as chamadas do webphone não
 * apareciam na lista, não contavam para os relatórios e não eram cobradas.
 *
 * COMO SE RESOLVE
 * O dialplan tem um "hangup handler" que, no fim de cada chamada de saída,
 * entrega o CDR à API. Chega uma vez por chamada, já com a duração real, o que
 * permite criar o registo e cobrar de uma só vez — sem reservas nem acertos.
 */
import { prisma } from "@falai/db";
import type { FastifyBaseLogger } from "fastify";
import { sipAuthUserFromEndpointId } from "@falai/providers";
import {
  computeCallCost,
  effectiveBillingMode,
  reserveBalance,
  type PriceConfig,
} from "./billing.service.js";

export interface WebphoneCdr {
  /** Nome do endpoint PJSIP de quem marcou (ex.: "extweb_Ab12", "ext_Ab12"). */
  endpoint: string;
  /** Número marcado, já normalizado pelo dialplan. */
  to: string;
  /** Segundos de conversa (0 se não atenderam). */
  billsec: number;
  /** ANSWERED / NO ANSWER / BUSY / FAILED / CONGESTION — do ${DIALSTATUS}. */
  disposition: string;
  /** Identificador único do canal no Asterisk — garante idempotência. */
  uniqueid: string;
}

/** Mapeia o resultado do Dial para o estado do registo. */
function statusFrom(disposition: string, billsec: number): "COMPLETED" | "NO_ANSWER" | "BUSY" | "FAILED" {
  const d = disposition.toUpperCase();
  if (d === "ANSWER" || d === "ANSWERED" || billsec > 0) return "COMPLETED";
  if (d === "BUSY") return "BUSY";
  if (d === "NOANSWER" || d === "NO ANSWER" || d === "CANCEL") return "NO_ANSWER";
  return "FAILED";
}

/**
 * Regista e cobra uma chamada marcada no telefone. Idempotente pelo `uniqueid`:
 * uma reentrega do dialplan não duplica o registo nem cobra duas vezes.
 */
export async function recordWebphoneCall(cdr: WebphoneCdr, log: FastifyBaseLogger): Promise<void> {
  const sipAuthUser = sipAuthUserFromEndpointId(cdr.endpoint);
  if (!sipAuthUser) {
    log.warn({ endpoint: cdr.endpoint }, "webphone_cdr.not_an_extension");
    return;
  }

  const ext = await prisma.extension.findFirst({
    where: { sipAuthUser },
    select: {
      number: true,
      tenant: {
        select: {
          id: true,
          billingModeOverride: true,
          plan: {
            select: { billingMode: true, pricePerMinuteCents: true, pricePerCallCents: true },
          },
        },
      },
    },
  });
  if (!ext?.tenant) {
    log.warn({ sipAuthUser }, "webphone_cdr.extension_not_found");
    return;
  }

  // Idempotência: o uniqueid do Asterisk é único e a coluna tem índice único.
  const existing = await prisma.call.findUnique({
    where: { yeastarCallId: cdr.uniqueid },
    select: { id: true },
  });
  if (existing) return;

  const { tenant } = ext;
  const price: PriceConfig = {
    billingMode: effectiveBillingMode(tenant.plan.billingMode, tenant.billingModeOverride),
    pricePerMinuteCents: tenant.plan.pricePerMinuteCents,
    pricePerCallCents: tenant.plan.pricePerCallCents,
  };
  const status = statusFrom(cdr.disposition, cdr.billsec);
  // Chamada não atendida não se cobra, seja qual for o modo de cobrança.
  const costCents = status === "COMPLETED" ? computeCallCost(cdr.billsec, price) : 0;

  const call = await prisma.call.create({
    data: {
      tenantId: tenant.id,
      kind: "DIRECT",
      toNumber: cdr.to,
      fromNumber: ext.number,
      status,
      outcome: status,
      durationSecs: cdr.billsec,
      billedSecs: cdr.billsec,
      costCents,
      yeastarCallId: cdr.uniqueid,
      startedAt: new Date(Date.now() - cdr.billsec * 1000),
      endedAt: new Date(),
    },
    select: { id: true },
  });

  if (costCents > 0) {
    // A chamada já aconteceu: se o saldo não chega, cobra-se na mesma e o
    // cliente fica negativo. Recusar aqui seria dar a chamada de graça.
    const ok = await reserveBalance(tenant.id, costCents);
    if (!ok) {
      // reserveBalance não debitou nada quando recusa: debitar à mão.
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { balanceCents: { decrement: costCents } },
      });
      log.warn({ tenantId: tenant.id, callId: call.id }, "webphone_cdr.charged_into_negative");
    }
    const balance = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { balanceCents: true },
    });
    await prisma.walletTransaction.create({
      data: {
        tenantId: tenant.id,
        type: "CALL_CHARGE",
        amountCents: -costCents,
        balanceAfterCents: balance.balanceCents,
        note: `Chamada do telefone ${ext.number} → ${cdr.to} — ${cdr.billsec}s`,
        reference: call.id,
      },
    });
  }

  log.info(
    { callId: call.id, tenantId: tenant.id, to: cdr.to, billsec: cdr.billsec, costCents },
    "webphone_cdr.recorded"
  );
}
