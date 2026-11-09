-- Grupos de linhas por cliente (ex.: 6 para cobrança, 6 para marketing).
-- Aditiva: tudo null, o comportamento actual mantém-se até se configurar.
ALTER TABLE "Tenant" ADD COLUMN "lineGroupLimits" JSONB;
ALTER TABLE "Tenant" ADD COLUMN "defaultLineGroup" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "lineGroup" TEXT;
