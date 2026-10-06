-- Inquéritos de satisfação (centro de atendimento, fase 8). Só aditivo.
-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "csatConfig" JSONB;

-- CreateTable
CREATE TABLE "CsatResponse" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "score" INTEGER,
    "callId" TEXT,
    "conversationId" TEXT,
    "ticketId" TEXT,
    "agentId" TEXT,
    "groupId" TEXT,
    "contactId" TEXT,
    "token" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "CsatResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CsatResponse_token_key" ON "CsatResponse"("token");

-- CreateIndex
CREATE INDEX "CsatResponse_tenantId_createdAt_idx" ON "CsatResponse"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CsatResponse_conversationId_idx" ON "CsatResponse"("conversationId");

-- CreateIndex
CREATE INDEX "CsatResponse_callId_idx" ON "CsatResponse"("callId");

-- AddForeignKey
ALTER TABLE "CsatResponse" ADD CONSTRAINT "CsatResponse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsatResponse" ADD CONSTRAINT "CsatResponse_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "TenantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

