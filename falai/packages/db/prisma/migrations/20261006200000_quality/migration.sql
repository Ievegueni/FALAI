-- Qualidade: formulários e avaliações (centro de atendimento, fase 7). Só aditivo.
-- CreateEnum
CREATE TYPE "QaStatus" AS ENUM ('SUBMITTED', 'ACKNOWLEDGED', 'DISPUTED', 'RESOLVED');

-- CreateTable
CREATE TABLE "QaForm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaEvaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "formId" TEXT,
    "formSnapshot" JSONB NOT NULL,
    "callId" TEXT,
    "conversationId" TEXT,
    "ticketId" TEXT,
    "agentId" TEXT NOT NULL,
    "evaluatorId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "criticalFail" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT,
    "status" "QaStatus" NOT NULL DEFAULT 'SUBMITTED',
    "agentComment" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QaEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QaForm_tenantId_name_key" ON "QaForm"("tenantId", "name");

-- CreateIndex
CREATE INDEX "QaEvaluation_tenantId_createdAt_idx" ON "QaEvaluation"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "QaEvaluation_tenantId_agentId_createdAt_idx" ON "QaEvaluation"("tenantId", "agentId", "createdAt");

-- CreateIndex
CREATE INDEX "QaEvaluation_callId_idx" ON "QaEvaluation"("callId");

-- AddForeignKey
ALTER TABLE "QaForm" ADD CONSTRAINT "QaForm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaEvaluation" ADD CONSTRAINT "QaEvaluation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaEvaluation" ADD CONSTRAINT "QaEvaluation_formId_fkey" FOREIGN KEY ("formId") REFERENCES "QaForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaEvaluation" ADD CONSTRAINT "QaEvaluation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "TenantUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaEvaluation" ADD CONSTRAINT "QaEvaluation_evaluatorId_fkey" FOREIGN KEY ("evaluatorId") REFERENCES "TenantUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

