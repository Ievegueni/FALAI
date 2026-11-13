-- SMS pós-chamada por campanha (ex.: link enviado a quem atendeu).
-- Aditiva: tudo null, nada muda até uma campanha trazer o texto.
ALTER TABLE "Campaign" ADD COLUMN "postCallSmsText" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "postCallSmsSenderId" TEXT;
ALTER TABLE "SmsMessage" ADD COLUMN "callId" TEXT;
CREATE INDEX "SmsMessage_callId_idx" ON "SmsMessage"("callId");
