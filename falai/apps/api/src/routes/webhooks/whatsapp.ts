import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@falai/db";
import { ingestInbound, inboxSecret } from "../../services/textChannels.service.js";
import { tenantHasFeature } from "../../services/features.js";

interface WaMessage {
  from: string; // wa_id = número em formato internacional sem "+"
  id: string;
  type: string;
  text?: { body: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
}

interface WaWebhook {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: WaMessage[];
      };
    }[];
  }[];
}

/** Texto legível de qualquer tipo de mensagem; media sem legenda vira marcador. */
function messageText(m: WaMessage): string {
  return (
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    m.image?.caption ??
    m.video?.caption ??
    m.document?.caption ??
    ({ image: "(imagem)", audio: "(áudio)", voice: "(nota de voz)", video: "(vídeo)", document: `(documento${m.document?.filename ? `: ${m.document.filename}` : ""})`, sticker: "(sticker)", location: "(localização)", contacts: "(contacto)" } as Record<string, string>)[m.type] ??
    `(${m.type})`
  );
}

/** A Meta assina o corpo cru com o App Secret (X-Hub-Signature-256: sha256=…). */
function validSignature(raw: string | Buffer, header: unknown, appSecret: string): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/**
 * Webhook do WhatsApp Business (Cloud API) de um inbox. Configura-se na app
 * da Meta: URL de callback = /webhooks/whatsapp/:inboxId, verify token =
 * Inbox.webhookSecret (ambos mostrados no CRM ao criar o canal).
 */
export const whatsappWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // Verificação do endpoint pela Meta (uma vez, ao configurar o webhook).
  fastify.get<{ Params: { inboxId: string }; Querystring: Record<string, string> }>("/:inboxId", async (request, reply) => {
    const inbox = await prisma.inbox.findFirst({
      where: { id: request.params.inboxId, channel: "WHATSAPP", deletedAt: null },
      select: { webhookSecret: true },
    });
    const q = request.query;
    if (inbox && q["hub.mode"] === "subscribe" && q["hub.verify_token"] === inbox.webhookSecret) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.status(403).send("forbidden");
  });

  fastify.post<{ Params: { inboxId: string }; Body: WaWebhook }>(
    "/:inboxId",
    { config: { rawBody: true } },
    async (request, reply) => {
      const inbox = await prisma.inbox.findFirst({
        where: { id: request.params.inboxId, channel: "WHATSAPP", enabled: true, deletedAt: null },
      });
      const appSecret = inbox ? inboxSecret(inbox, "appSecret") : null;
      if (!inbox || !appSecret || !request.rawBody || !validSignature(request.rawBody, request.headers["x-hub-signature-256"], appSecret)) {
        return reply.status(401).send({ ok: false });
      }
      // Funcionalidade desligada: aceita (senão a Meta reenvia) e ignora.
      if (!(await tenantHasFeature(inbox.tenantId, "inbox"))) return { ok: true };

      // A Meta também manda aqui os estados (sent/delivered/read) — ignorados por agora.
      for (const entry of request.body?.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          for (const m of value?.messages ?? []) {
            // A Meta reenvia se não responder a tempo: não duplicar.
            // ponytail: sem índice em Message.externalId; criar um se o volume crescer.
            const dup = await prisma.message.findFirst({ where: { externalId: m.id, conversation: { inboxId: inbox.id } }, select: { id: true } });
            if (dup) continue;
            const name = value?.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
            void ingestInbound(fastify, inbox, {
              externalRef: m.from,
              externalId: m.id,
              text: messageText(m),
              identity: { phone: m.from, ...(name && { name }) },
            }).catch((err) => fastify.log.error({ err, inboxId: inbox.id }, "whatsapp.ingest_failed"));
          }
        }
      }
      return { ok: true };
    }
  );
};
