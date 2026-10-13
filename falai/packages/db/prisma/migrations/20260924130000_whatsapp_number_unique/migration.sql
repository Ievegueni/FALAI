-- Um número WhatsApp (phone_number_id da Meta) só pode estar ligado a um canal,
-- em todos os tenants. Canais apagados libertam o número.
--
-- Salvaguarda: com duplicados o CREATE UNIQUE INDEX falharia com um erro
-- genérico; assim pára com a lista dos números repetidos. Resolver (apagar ou
-- trocar o número de um dos canais) e voltar a correr.
DO $$
DECLARE
  dups text;
BEGIN
  SELECT string_agg(pid || ' (' || n || ' canais)', ', ') INTO dups
  FROM (
    SELECT config->>'phoneNumberId' AS pid, count(*) AS n
    FROM "Inbox"
    WHERE channel = 'WHATSAPP' AND "deletedAt" IS NULL AND config->>'phoneNumberId' IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'whatsapp_number_unique: phoneNumberId ligado a mais de um canal WhatsApp activo: %', dups;
  END IF;
END $$;

CREATE UNIQUE INDEX "Inbox_wa_phone_number_unique" ON "Inbox" ((config->>'phoneNumberId'))
  WHERE channel = 'WHATSAPP' AND "deletedAt" IS NULL;
