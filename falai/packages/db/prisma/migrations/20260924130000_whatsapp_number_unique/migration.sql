-- Um número WhatsApp (phone_number_id da Meta) só pode estar ligado a um canal,
-- em todos os tenants. Canais apagados libertam o número.
CREATE UNIQUE INDEX "Inbox_wa_phone_number_unique" ON "Inbox" ((config->>'phoneNumberId'))
  WHERE channel = 'WHATSAPP' AND "deletedAt" IS NULL;
