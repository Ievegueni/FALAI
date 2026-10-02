-- Relatórios de atendimento: pernas por extensão (CallLeg), motivos de recusa
-- por tenant e início do toque/grupo na chamada. Só aditivo.
-- CreateEnum
CREATE TYPE "CallLegOutcome" AS ENUM ('ANSWERED', 'NO_ANSWER', 'REJECTED', 'BUSY', 'CANCELLED', 'FAILED');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "queuedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CallLeg" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "extensionId" TEXT,
    "extensionNumber" TEXT NOT NULL,
    "groupId" TEXT,
    "ringStartedAt" TIMESTAMP(3) NOT NULL,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "outcome" "CallLegOutcome",
    "hangupCause" INTEGER,
    "rejectReasonId" TEXT,
    "rejectNote" TEXT,

    CONSTRAINT "CallLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RejectReason" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RejectReason_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallLeg_tenantId_ringStartedAt_idx" ON "CallLeg"("tenantId", "ringStartedAt");

-- CreateIndex
CREATE INDEX "CallLeg_tenantId_extensionId_ringStartedAt_idx" ON "CallLeg"("tenantId", "extensionId", "ringStartedAt");

-- CreateIndex
CREATE INDEX "CallLeg_tenantId_groupId_ringStartedAt_idx" ON "CallLeg"("tenantId", "groupId", "ringStartedAt");

-- CreateIndex
CREATE INDEX "CallLeg_callId_idx" ON "CallLeg"("callId");

-- CreateIndex
CREATE UNIQUE INDEX "RejectReason_tenantId_label_key" ON "RejectReason"("tenantId", "label");

-- CreateIndex
CREATE INDEX "Call_tenantId_kind_startedAt_idx" ON "Call"("tenantId", "kind", "startedAt");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ExtensionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ExtensionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_rejectReasonId_fkey" FOREIGN KEY ("rejectReasonId") REFERENCES "RejectReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RejectReason" ADD CONSTRAINT "RejectReason_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

