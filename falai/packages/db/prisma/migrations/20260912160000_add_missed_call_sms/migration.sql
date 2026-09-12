-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "missedCallSms" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "missedCallSmsText" TEXT;

-- AlterTable
ALTER TABLE "SmsMessage" ADD COLUMN     "trigger" TEXT;

-- CreateIndex
-- Serve o travão de um SMS automático por número por dia.
CREATE INDEX "SmsMessage_tenantId_toNumber_trigger_createdAt_idx" ON "SmsMessage"("tenantId", "toNumber", "trigger", "createdAt");
