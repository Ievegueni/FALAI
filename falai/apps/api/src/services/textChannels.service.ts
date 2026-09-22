import type { FastifyInstance } from "fastify";
import { prisma, type Channel, type Inbox, type Prisma, type TurnRole } from "@falai/db";
import type { TurnMessage } from "@falai/providers";
import { processTextTurn } from "./TurnProcessor.js";
import { resolveModelForAgent } from "./modelResolver.service.js";
import { decryptSecret } from "./crypto.service.js";
import { sendEmailReply } from "./email.service.js";
import { chargeTextMessage } from "./billing.service.js";
import { emitWebhookAsync } from "./webhookEmitter.service.js";

/**
 * Canais de texto (Telegram, widget web, email) — ver docs/PLANO-CANAIS-TEXTO.md.
 *
 * Adaptador de canal → ingestInbound() → Conversation/Message → IA (o mesmo
 * processTextTurn da voz) ou humano → deliver() pelo canal de origem.
 * Tempo real: `fastify.incomingCalls` (CRM, por tenant) e `fastify.widgetHub`
 * (visitante do widget, por token de sessão).
 *
 * Mensagens com role SYSTEM são notas internas: nunca saem para o canal nem
 * entram no histórico do LLM.
 */

const HISTORY_LIMIT = 30;

// ── Telegram (Bot API pura, sem dependências) ────────────────────────────────

export async function telegramApi(botToken: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
  return json.result;
}

// ── WhatsApp Business (Cloud API da Meta, sem dependências) ─────────────────

export const GRAPH_API = "https://graph.facebook.com/v21.0";

export async function whatsappApi(accessToken: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${GRAPH_API}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { error?: { message?: string } };
  if (!res.ok || json.error) throw new Error(`WhatsApp ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

/**
 * O mesmo número aparece como "923000000" (formato nacional, o actual no CRM),
 * "+244923000000" (legado) ou "244923000000" (wa_id do WhatsApp).
 */
export function phoneVariants(raw: string): string[] {
  const digits = raw.replace(/\D/g, "");
  const national = digits.startsWith("244") && digits.length === 12 ? digits.slice(3) : null;
  return [...new Set([raw, digits, `+${digits}`, ...(national ? [national, `+244${national}`, `244${national}`] : [])])];
}

export function inboxSecret(inbox: Pick<Inbox, "config">, key: string): string | null {
  const v = (inbox.config as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v ? decryptSecret(v) : null;
}

// ── Núcleo ───────────────────────────────────────────────────────────────────

export interface InboundMessage {
  externalRef: string;
  text: string;
  externalId?: string;
  subject?: string;
  attachments?: Prisma.InputJsonValue;
  identity: { telegramId?: string; email?: string; phone?: string; name?: string };
}

/** Contacto pela identidade do canal. Null = anónimo (visitante do widget). */
export async function resolveContact(tenantId: string, id: InboundMessage["identity"]): Promise<string | null> {
  const create = { tenantId, ...(id.name && { name: id.name }) };
  if (id.telegramId) {
    const c = await prisma.contact.upsert({
      where: { tenantId_telegramId: { tenantId, telegramId: id.telegramId } },
      create: { ...create, telegramId: id.telegramId },
      update: {},
      select: { id: true },
    });
    return c.id;
  }
  if (id.email) {
    const email = id.email.toLowerCase();
    const c = await prisma.contact.upsert({
      where: { tenantId_email: { tenantId, email } },
      create: { ...create, email },
      update: {},
      select: { id: true },
    });
    return c.id;
  }
  if (id.phone) {
    // Reaproveita o contacto existente em qualquer formato do número; se não
    // houver, grava no formato nacional (o que o CRM usa hoje).
    const variants = phoneVariants(id.phone);
    const existing = await prisma.contact.findFirst({ where: { tenantId, phone: { in: variants } }, select: { id: true } });
    if (existing) return existing.id;
    const phone = variants.find((v) => /^9\d{8}$/.test(v)) ?? id.phone;
    const c = await prisma.contact.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { ...create, phone },
      update: {},
      select: { id: true },
    });
    return c.id;
  }
  return null;
}

export async function appendMessage(
  fastify: FastifyInstance,
  conv: { id: string; tenantId: string; inboxId: string; externalRef: string },
  data: {
    role: TurnRole;
    text: string;
    authorId?: string | null;
    externalId?: string | null;
    attachments?: Prisma.InputJsonValue;
    llmMs?: number;
    modelId?: string | null;
    costCents?: number;
    guardrailFlags?: Prisma.InputJsonValue;
  }
) {
  // O contador na conversa dá o seq sem corrida (update é atómico).
  const { messageCount } = await prisma.conversation.update({
    where: { id: conv.id },
    data: { messageCount: { increment: 1 }, lastMessageAt: new Date() },
    select: { messageCount: true },
  });
  const message = await prisma.message.create({
    data: { conversationId: conv.id, seq: messageCount, ...data },
  });
  fastify.incomingCalls.broadcast(conv.tenantId, "conversation.message", { conversationId: conv.id, message });
  if (data.role !== "SYSTEM") {
    emitWebhookAsync({
      tenantId: conv.tenantId,
      event: "conversation.message",
      payload: { conversationId: conv.id, messageId: message.id, role: message.role, text: message.text, createdAt: message.createdAt },
    });
  }
  if (data.role !== "SYSTEM") fastify.widgetHub.broadcast(widgetKey(conv.inboxId, conv.externalRef), "message", publicMessage(message));
  return message;
}

/** Chave do stream do widget: o token do visitante sobrevive a conversas resolvidas. */
export const widgetKey = (inboxId: string, token: string) => `${inboxId}:${token}`;

/** O que o visitante do widget pode ver de uma mensagem. */
export function publicMessage(m: { id: string; seq: number; role: TurnRole; text: string; createdAt: Date }) {
  return { id: m.id, seq: m.seq, role: m.role === "HUMAN" ? "visitor" : "agent", text: m.text, createdAt: m.createdAt };
}

export function broadcastConversation(fastify: FastifyInstance, tenantId: string, conversationId: string, changes: Record<string, unknown>) {
  fastify.incomingCalls.broadcast(tenantId, "conversation.updated", { conversationId, ...changes });
}

/** Mensagem do cliente final a entrar por qualquer canal. */
export async function ingestInbound(fastify: FastifyInstance, inbox: Inbox, msg: InboundMessage) {
  // ponytail: duas mensagens simultâneas do mesmo remetente podem abrir duas
  // conversas. Raro em texto; resolver com índice parcial se aparecer.
  let conv = await prisma.conversation.findFirst({
    where: { inboxId: inbox.id, externalRef: msg.externalRef, status: { not: "RESOLVED" } },
    orderBy: { createdAt: "desc" },
  });
  if (!conv) {
    const contactId = await resolveContact(inbox.tenantId, msg.identity);
    conv = await prisma.conversation.create({
      data: {
        tenantId: inbox.tenantId,
        inboxId: inbox.id,
        externalRef: msg.externalRef,
        contactId,
        subject: msg.subject ?? null,
        mode: inbox.agentId && inbox.autoReply ? "AI" : "HUMAN",
      },
    });
    fastify.incomingCalls.broadcast(inbox.tenantId, "conversation.created", { conversation: conv, channel: inbox.channel });
    emitWebhookAsync({
      tenantId: inbox.tenantId,
      event: "conversation.created",
      payload: { conversationId: conv.id, inboxId: inbox.id, channel: inbox.channel, contactId: conv.contactId },
    });
  } else if (conv.status === "PENDING") {
    conv = await prisma.conversation.update({ where: { id: conv.id }, data: { status: "OPEN" } });
    broadcastConversation(fastify, conv.tenantId, conv.id, { status: "OPEN" });
  }

  await appendMessage(fastify, conv, {
    role: "HUMAN",
    text: msg.text,
    externalId: msg.externalId ?? null,
    ...(msg.attachments !== undefined && { attachments: msg.attachments }),
  });

  // Não se espera pela IA: o canal (webhook, widget) responde já e a resposta
  // segue pelo canal quando estiver pronta.
  if (conv.mode === "AI" && inbox.agentId && inbox.autoReply) {
    const id = conv.id;
    void replyWithAi(fastify, inbox, id).catch((err) => fastify.log.error({ err, conversationId: id }, "text.ai_reply_failed"));
  }
  return conv;
}

function channelNote(channel: Channel): string {
  const name = { WEBCHAT: "chat no site", EMAIL: "email", TELEGRAM: "Telegram", WHATSAPP: "WhatsApp" }[channel];
  return [
    "",
    "## Canal",
    `Esta conversa é por texto (${name}), não por telefone. Ignore instruções sobre chamadas, voz ou desligar.`,
    "Se o cliente pedir um humano ou não souber ajudar, use a acção escalate — um operador assume a conversa.",
    channel === "EMAIL" ? "Responda em formato de email: cumprimento, corpo, despedida." : "Respostas curtas, como numa conversa de chat.",
  ].join("\n");
}

async function replyWithAi(fastify: FastifyInstance, inbox: Inbox, conversationId: string) {
  const agent = await prisma.agent.findFirst({
    where: { id: inbox.agentId!, deletedAt: null, status: "ACTIVE" },
    select: { id: true, systemPrompt: true },
  });
  if (!agent) return;

  // Cobra-se antes de gerar: sem saldo, passa para humano em vez de responder de graça.
  const costCents = await chargeTextMessage(inbox.tenantId, conversationId);
  if (costCents === null) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { mode: "HUMAN" } });
    broadcastConversation(fastify, inbox.tenantId, conversationId, { mode: "HUMAN", reason: "insufficient_balance" });
    return;
  }

  let model: Awaited<ReturnType<typeof resolveModelForAgent>> = { llm: null, modelId: null };
  try {
    model = await resolveModelForAgent(agent.id);
  } catch (err) {
    fastify.log.error({ err, agentId: agent.id }, "text.model_resolve_failed");
  }

  const recent = await prisma.message.findMany({
    where: { conversationId, role: { not: "SYSTEM" } },
    orderBy: { seq: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, text: true },
  });
  const [last, ...older] = recent;
  if (!last || last.role !== "HUMAN") return;
  const history: TurnMessage[] = older.reverse().map((m) => ({ role: m.role === "AGENT" ? "agent" : "human", text: m.text }));

  const { response, llmMs, guard } = await processTextTurn({
    llm: model.llm ?? fastify.llm,
    systemPrompt: agent.systemPrompt + "\n" + channelNote(inbox.channel),
    history,
    userText: last.text,
    variables: {},
    tenantId: inbox.tenantId,
    refId: conversationId,
    agentId: agent.id,
    modelId: model.modelId,
    // Em texto, "escalate" é passar para humano — não há número para onde transferir.
    escalateIsHandoff: true,
    ...(model.maxReplyChars !== undefined && { maxReplyChars: model.maxReplyChars }),
  });

  // Um operador pode ter assumido a conversa enquanto o modelo pensava.
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.mode !== "AI") return;

  const msg = await appendMessage(fastify, conv, {
    role: "AGENT",
    text: response.reply,
    llmMs,
    modelId: model.modelId,
    costCents,
    ...(guard.violated && { guardrailFlags: guard.flags }),
  });
  await deliver(fastify, inbox, conv, response.reply, msg.id);

  if (response.action.type === "escalate") {
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: "HUMAN", status: "OPEN" } });
    broadcastConversation(fastify, conv.tenantId, conv.id, { mode: "HUMAN", handoff: true });
  }
}

/** Envia texto pelo canal de origem. O widget já recebeu via widgetHub em appendMessage. */
export async function deliver(
  fastify: FastifyInstance,
  inbox: Inbox,
  conv: { id: string; tenantId: string; externalRef: string; subject: string | null; contactId: string | null },
  text: string,
  messageId: string
): Promise<void> {
  try {
    if (inbox.channel === "TELEGRAM") {
      const token = inboxSecret(inbox, "botToken");
      if (!token) throw new Error("Inbox Telegram sem botToken");
      const sent = (await telegramApi(token, "sendMessage", { chat_id: conv.externalRef, text })) as { message_id: number };
      await prisma.message.update({ where: { id: messageId }, data: { externalId: String(sent.message_id) } });
    } else if (inbox.channel === "WHATSAPP") {
      const token = inboxSecret(inbox, "accessToken");
      const phoneNumberId = (inbox.config as { phoneNumberId?: string }).phoneNumberId;
      if (!token || !phoneNumberId) throw new Error("Inbox WhatsApp sem accessToken/phoneNumberId");
      // Fora da janela de 24 h desde a última mensagem do cliente a Meta recusa
      // texto livre (exige template) — o erro chega aqui e fica visível no CRM.
      const sent = (await whatsappApi(token, `${phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: conv.externalRef,
        type: "text",
        text: { body: text },
      })) as { messages?: { id: string }[] };
      const externalId = sent.messages?.[0]?.id;
      if (externalId) await prisma.message.update({ where: { id: messageId }, data: { externalId } });
    } else if (inbox.channel === "EMAIL") {
      const externalId = await sendEmailReply(inbox, conv, text);
      await prisma.message.update({ where: { id: messageId }, data: { externalId } });
    }
  } catch (err) {
    fastify.log.error({ err, conversationId: conv.id, channel: inbox.channel }, "text.deliver_failed");
    await prisma.systemEvent
      .create({
        data: {
          severity: "ERROR",
          source: "text-channels",
          tenantId: inbox.tenantId,
          message: `Falha a enviar mensagem por ${inbox.channel}: ${err instanceof Error ? err.message : String(err)}`,
          payload: { conversationId: conv.id, messageId },
        },
      })
      .catch(() => {});
    fastify.incomingCalls.broadcast(inbox.tenantId, "conversation.deliveryFailed", { conversationId: conv.id, messageId });
  }
}
