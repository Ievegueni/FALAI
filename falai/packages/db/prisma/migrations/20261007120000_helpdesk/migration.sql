-- Ligação a helpdesk externo (Freshdesk) por cliente (centro de atendimento, fase 3). Só aditivo.
-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "externalSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "HelpdeskConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'FRESHDESK',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "domain" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "webhookToken" TEXT NOT NULL,
    "ticketOnCall" TEXT NOT NULL DEFAULT 'AGENT_CHOICE',
    "includeRecordingLink" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HelpdeskConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HelpdeskConnection_tenantId_key" ON "HelpdeskConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "HelpdeskConnection_webhookToken_key" ON "HelpdeskConnection"("webhookToken");

-- AddForeignKey
ALTER TABLE "HelpdeskConnection" ADD CONSTRAINT "HelpdeskConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

