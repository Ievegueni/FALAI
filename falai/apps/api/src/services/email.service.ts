import type { FastifyInstance } from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { prisma, type Inbox } from "@falai/db";
import { ingestInbound, inboxSecret } from "./textChannels.service.js";
import { stripQuoted } from "./stripQuoted.js";
import { tenantHasFeature } from "./features.js";

/**
 * Canal de email. Não somos servidor de email: o cliente faz forward de
 * suporte@ele.com para uma caixa nossa (config do inbox), lemos por IMAP a cada
 * minuto e respondemos por SMTP com Reply-To do domínio dele.
 *
 * Config do inbox (segredos cifrados): imapHost, imapPort, imapUser, imapPass,
 * smtpHost, smtpPort, smtpUser, smtpPass, fromAddress, replyTo?.
 */

export const UPLOADS_DIR = process.env["UPLOADS_DIR"] ?? path.resolve("uploads");
const POLL_MS = 60_000;

interface EmailConfig {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  fromAddress: string;
  replyTo?: string;
}

function cfg(inbox: Inbox): EmailConfig {
  return inbox.config as unknown as EmailConfig;
}

function asArray(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

async function saveAttachments(tenantId: string, parsed: ParsedMail) {
  if (parsed.attachments.length === 0) return undefined;
  const dir = path.join(UPLOADS_DIR, tenantId);
  await mkdir(dir, { recursive: true });
  const saved = [];
  for (const a of parsed.attachments) {
    const file = `${randomUUID()}${path.extname(a.filename ?? "")}`;
    await writeFile(path.join(dir, file), a.content);
    saved.push({ file, name: a.filename ?? file, contentType: a.contentType, size: a.size });
  }
  return saved;
}

/** Processa um email cru (também usado nos testes). */
export async function ingestEmail(fastify: FastifyInstance, inbox: Inbox, raw: Buffer | string) {
  const parsed = await simpleParser(raw);
  const from = parsed.from?.value[0];
  if (!from?.address) return;
  // Não responder a nós próprios nem a bounces automáticos.
  if (from.address.toLowerCase() === cfg(inbox).fromAddress.toLowerCase()) return;
  if (/^(mailer-daemon|postmaster|no-?reply)@/i.test(from.address) || parsed.headers.get("auto-submitted")) return;

  const messageId = parsed.messageId ?? `<${randomUUID()}@falai>`;
  const refs = [...asArray(parsed.references), ...asArray(parsed.inReplyTo)];

  // Threading: se referencia uma mensagem já conhecida, é a mesma conversa.
  let externalRef = messageId;
  if (refs.length > 0) {
    const known = await prisma.message.findFirst({
      where: { externalId: { in: refs }, conversation: { inboxId: inbox.id } },
      select: { conversation: { select: { externalRef: true } } },
    });
    externalRef = known?.conversation.externalRef ?? refs[0]!;
  }

  const attachments = await saveAttachments(inbox.tenantId, parsed);
  const text = stripQuoted(parsed.text ?? "") || (attachments ? "(anexo)" : "");
  if (!text) return;

  await ingestInbound(fastify, inbox, {
    externalRef,
    externalId: messageId,
    text,
    ...(parsed.subject && { subject: parsed.subject }),
    ...(attachments && { attachments }),
    identity: { email: from.address, ...(from.name && { name: from.name }) },
  });
}

async function pollInbox(fastify: FastifyInstance, inbox: Inbox) {
  const c = cfg(inbox);
  const client = new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: c.imapPort === 993,
    auth: { user: c.imapUser, pass: inboxSecret(inbox, "imapPass") ?? "" },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      // Marca como lido antes de processar: um email estragado não pode
      // ficar a ser reprocessado (e a gastar LLM) a cada minuto.
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      if (!msg || !msg.source) continue;
      await ingestEmail(fastify, inbox, msg.source).catch((err) =>
        fastify.log.error({ err, inboxId: inbox.id, uid }, "email.ingest_failed")
      );
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

/**
 * ponytail: polling em processo (setInterval) em vez de job BullMQ. Com mais de
 * uma instância da API, passar para um job repetível — o \Seen evita a maior
 * parte dos duplicados mas não todos.
 */
export function startEmailPolling(fastify: FastifyInstance): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const inboxes = await prisma.inbox.findMany({ where: { channel: "EMAIL", enabled: true, deletedAt: null } });
      for (const inbox of inboxes) {
        if (!(await tenantHasFeature(inbox.tenantId, "inbox"))) continue;
        await pollInbox(fastify, inbox).catch((err) =>
          fastify.log.warn({ err: err instanceof Error ? err.message : err, inboxId: inbox.id }, "email.poll_failed")
        );
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  return () => clearInterval(timer);
}

/** Responde por SMTP na mesma thread. Devolve o Message-ID enviado. */
export async function sendEmailReply(
  inbox: Inbox,
  conv: { id: string; subject: string | null; contactId: string | null },
  text: string
): Promise<string> {
  const c = cfg(inbox);
  const contact = conv.contactId
    ? await prisma.contact.findUnique({ where: { id: conv.contactId }, select: { email: true } })
    : null;
  if (!contact?.email) throw new Error("Conversa de email sem endereço do contacto");

  const refs = await prisma.message.findMany({
    where: { conversationId: conv.id, externalId: { not: null } },
    orderBy: { seq: "asc" },
    select: { externalId: true, role: true },
  });
  const lastHuman = [...refs].reverse().find((r) => r.role === "HUMAN");

  const transport = nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpPort === 465,
    auth: { user: c.smtpUser, pass: inboxSecret(inbox, "smtpPass") ?? "" },
  });
  const subject = conv.subject ? (/^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`) : "Re:";
  const info = await transport.sendMail({
    from: c.fromAddress,
    ...(c.replyTo && { replyTo: c.replyTo }),
    to: contact.email,
    subject,
    text,
    ...(lastHuman?.externalId && { inReplyTo: lastHuman.externalId }),
    references: refs.map((r) => r.externalId!).join(" "),
  });
  return info.messageId;
}
