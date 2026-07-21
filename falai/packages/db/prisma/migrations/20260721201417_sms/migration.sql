-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- AlterEnum
ALTER TYPE "TxType" ADD VALUE 'SMS_CHARGE';

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "pricePerSmsCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "smsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "smsApiKey" TEXT,
ADD COLUMN     "smsPriceSegmentCents" INTEGER,
ADD COLUMN     "smsSenderId" TEXT;

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT,
    "campaignId" TEXT,
    "toNumber" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "senderId" TEXT,
    "providerMsgId" TEXT,
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsCampaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "throttlePerMinute" INTEGER NOT NULL DEFAULT 60,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsMessage_tenantId_createdAt_idx" ON "SmsMessage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_providerMsgId_idx" ON "SmsMessage"("providerMsgId");

-- CreateIndex
CREATE INDEX "SmsCampaign_tenantId_createdAt_idx" ON "SmsCampaign"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SmsCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsCampaign" ADD CONSTRAINT "SmsCampaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
