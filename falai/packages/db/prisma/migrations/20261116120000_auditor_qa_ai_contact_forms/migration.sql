-- Perfil de auditor, auditoria com IA e fichas de recolha de dados. Só aditivo
-- (o DROP NOT NULL só alarga o que a coluna aceita).
ALTER TYPE "TenantRole" ADD VALUE 'AUDITOR';
ALTER TYPE "TxType" ADD VALUE 'QA_CHARGE';
ALTER TYPE "QaStatus" ADD VALUE 'AI_DRAFT' BEFORE 'SUBMITTED';

ALTER TABLE "QaEvaluation" ALTER COLUMN "evaluatorId" DROP NOT NULL;
ALTER TABLE "QaEvaluation" ADD COLUMN "aiFindings" JSONB;

ALTER TABLE "Tenant" ADD COLUMN "qaAiFormId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "qaAiSamplePct" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tenant" ADD COLUMN "qaAiPricePerMinCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Call" ADD COLUMN "formData" JSONB;

CREATE TABLE "ContactForm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactForm_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContactForm_tenantId_name_key" ON "ContactForm"("tenantId", "name");
ALTER TABLE "ContactForm" ADD CONSTRAINT "ContactForm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
