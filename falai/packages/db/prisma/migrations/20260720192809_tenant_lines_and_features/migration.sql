-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "features" JSONB;

-- CreateTable
CREATE TABLE "TenantLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantLine_tenantId_idx" ON "TenantLine"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantLine" ADD CONSTRAINT "TenantLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
