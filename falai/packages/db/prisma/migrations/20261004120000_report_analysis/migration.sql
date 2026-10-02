-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "aiReportAgentNames" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiReportDailyLimit" INTEGER NOT NULL DEFAULT 20;

-- CreateTable
CREATE TABLE "ReportAnalysis" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "filtersKey" TEXT NOT NULL,
    "dataHash" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportAnalysis_tenantId_filtersKey_createdAt_idx" ON "ReportAnalysis"("tenantId", "filtersKey", "createdAt");

-- CreateIndex
CREATE INDEX "ReportAnalysis_tenantId_createdAt_idx" ON "ReportAnalysis"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReportAnalysis" ADD CONSTRAINT "ReportAnalysis_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

