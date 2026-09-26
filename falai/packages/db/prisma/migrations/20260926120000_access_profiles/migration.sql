-- Perfis de acesso ao CRM geridos no backoffice
CREATE TABLE "AccessProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccessProfile_tenantId_name_key" ON "AccessProfile"("tenantId", "name");

ALTER TABLE "AccessProfile" ADD CONSTRAINT "AccessProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TenantUser" ADD COLUMN "accessProfileId" TEXT;

ALTER TABLE "TenantUser" ADD CONSTRAINT "TenantUser_accessProfileId_fkey" FOREIGN KEY ("accessProfileId") REFERENCES "AccessProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
