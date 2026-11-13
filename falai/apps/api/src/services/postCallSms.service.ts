/**
 * SMS pós-chamada: a campanha diz ao cliente "envio-lhe o link por SMS" e é
 * aqui que essa SMS sai, a quem ATENDEU.
 *
 * Configura-se por campanha (Campaign.postCallSmsText / postCallSmsSenderId,
 * via `postCallSms` no POST/PATCH /v1/campaigns). Regras:
 *   1. só para chamadas atendidas (COMPLETED com answeredAt); quem não atendeu
 *      não ouviu a promessa;
 *   2. no máximo UMA SMS por chamada (o travão é SmsMessage.callId);
 *   3. falhar a enviar nunca estraga o fecho da chamada.
 */
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import { sendSms, getTenantSmsConfig } from "./sms.service.js";
import { isSmsReachable } from "./missedCallSms.service.js";

export const POST_CALL_TRIGGER = "POST_CALL";

/** Até 4 segmentos GSM: chega para um texto curto com link. */
export const POST_CALL_SMS_MAX_CHARS = 612;
/** Remetente alfanumérico, como os registados na Futurix (ex.: DFACIL). */
const SENDER_ID_RE = /^[A-Za-z0-9 .\-]{1,11}$/;

/** Substitui {nome}, {numero} e {empresa}. Variável sem valor fica vazia. */
export function renderPostCallText(
  template: string,
  vars: { nome: string; numero: string; empresa: string }
): string {
  return template
    .replace(/\{(\w+)\}/g, (match, key: string) => {
      const value = (vars as Record<string, string>)[key];
      return value === undefined ? match : value;
    })
    // "Olá , tem..." quando o nome vem vazio
    .replace(/ +([,.!?])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

export type PostCallSmsInput = { text?: unknown; senderId?: unknown } | null | undefined;
export type PostCallSmsParsed =
  | { ok: true; value: { text: string; senderId: string | null } | null }
  | { ok: false; error: string };

/** Valida `postCallSms` do pedido. null = desligar. */
export function parsePostCallSms(input: PostCallSmsInput): PostCallSmsParsed {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "object") return { ok: false, error: "postCallSms must be an object { text, senderId? } or null" };
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return { ok: false, error: "postCallSms.text is required" };
  if (text.length > POST_CALL_SMS_MAX_CHARS) {
    return { ok: false, error: `postCallSms.text is too long (max ${POST_CALL_SMS_MAX_CHARS} characters)` };
  }
  let senderId: string | null = null;
  if (input.senderId !== undefined && input.senderId !== null && input.senderId !== "") {
    if (typeof input.senderId !== "string" || !SENDER_ID_RE.test(input.senderId)) {
      return { ok: false, error: "postCallSms.senderId must have 1-11 letters/digits" };
    }
    senderId = input.senderId;
  }
  return { ok: true, value: { text, senderId } };
}

/** O cliente consegue mesmo enviar SMS? Evita aceitar campanhas que nunca mandariam nada. */
export async function tenantCanSendSms(tenantId: string): Promise<boolean> {
  try {
    const cfg = await getTenantSmsConfig(tenantId);
    return cfg.smsEnabled && !!cfg.apiKey;
  } catch {
    return false;
  }
}

export interface PostCallParams {
  fastify: FastifyInstance;
  tenantId: string;
  callId: string;
  status: string;
  log: FastifyBaseLogger;
}

/** Envia, se for caso disso, a SMS pós-chamada. Nunca lança. */
export async function notifyPostCall(params: PostCallParams): Promise<void> {
  const { fastify, tenantId, callId, status, log } = params;
  if (status !== "COMPLETED") return;
  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        tenantId: true,
        toNumber: true,
        answeredAt: true,
        contactId: true,
        contact: { select: { name: true } },
        campaign: { select: { postCallSmsText: true, postCallSmsSenderId: true, tenant: { select: { name: true } } } },
      },
    });
    const template = call?.campaign?.postCallSmsText?.trim();
    if (!call || call.tenantId !== tenantId || !template) return;
    if (!call.answeredAt) return;
    if (!isSmsReachable(call.toNumber)) return;

    const already = await prisma.smsMessage.findFirst({
      where: { tenantId, callId, trigger: POST_CALL_TRIGGER },
      select: { id: true },
    });
    if (already) return;

    const body = renderPostCallText(template, {
      nome: call.contact?.name?.trim() ?? "",
      numero: call.toNumber!,
      empresa: call.campaign!.tenant.name,
    });
    const sent = await sendSms(fastify, tenantId, {
      to: call.toNumber!,
      body,
      trigger: POST_CALL_TRIGGER,
      callId,
      contactId: call.contactId,
      senderId: call.campaign!.postCallSmsSenderId,
    });
    log.info({ tenantId, callId, smsId: sent.id, status: sent.status }, "post_call_sms.sent");
  } catch (err) {
    log.warn({ err, tenantId, callId }, "post_call_sms.failed");
  }
}
