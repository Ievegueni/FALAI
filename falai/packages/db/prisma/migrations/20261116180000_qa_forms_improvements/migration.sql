-- Fichas por grupo, palavras proibidas e alerta de qualidade. Só aditivo.
ALTER TYPE "AlertType" ADD VALUE 'QA_LOW_STREAK';
ALTER TABLE "ContactForm" ADD COLUMN "groupIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Tenant" ADD COLUMN "qaForbiddenWords" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Tenant" ADD COLUMN "qaAlertThreshold" INTEGER NOT NULL DEFAULT 0;
