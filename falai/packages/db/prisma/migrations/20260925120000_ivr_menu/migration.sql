-- CreateTable
CREATE TABLE "IvrMenu" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "greeting" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "timeoutSecs" INTEGER NOT NULL DEFAULT 6,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IvrMenu_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IvrMenu_tenantId_name_key" ON "IvrMenu"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "IvrMenu" ADD CONSTRAINT "IvrMenu_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
