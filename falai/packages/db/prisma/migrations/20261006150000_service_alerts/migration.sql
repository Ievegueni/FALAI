-- Metas e alertas operacionais (centro de atendimento, fase 4). Só aditivo.
-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('LONG_WAIT', 'LONG_HANDLE', 'NO_AGENTS', 'SLA_BELOW', 'ABANDON_ABOVE', 'TMA_ABOVE');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "serviceTargets" JSONB;

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "ref" TEXT NOT NULL,
    "groupId" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "endValue" DOUBLE PRECISION,
    "openKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Alert_openKey_key" ON "Alert"("openKey");

-- CreateIndex
CREATE INDEX "Alert_tenantId_startedAt_idx" ON "Alert"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "Alert_tenantId_endedAt_idx" ON "Alert"("tenantId", "endedAt");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

