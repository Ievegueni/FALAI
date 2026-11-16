-- Revogação de sessões (aditivo, sem perda de dados)
ALTER TABLE "TenantUser" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AdminUser" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
