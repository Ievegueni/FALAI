-- CreateTable
CREATE TABLE "IvrMenu" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "greetingPrompt" TEXT NOT NULL,
    "invalidPrompt" TEXT,
    "timeoutSecs" INTEGER NOT NULL DEFAULT 5,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "timeoutDestType" TEXT,
    "timeoutDestValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IvrMenu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IvrOption" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "digit" TEXT NOT NULL,
    "destType" TEXT NOT NULL DEFAULT 'EXTENSION',
    "destValue" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "IvrOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IvrMenu_tenantId_idx" ON "IvrMenu"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "IvrMenu_tenantId_name_key" ON "IvrMenu"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "IvrOption_menuId_digit_key" ON "IvrOption"("menuId", "digit");

-- AddForeignKey
ALTER TABLE "IvrMenu" ADD CONSTRAINT "IvrMenu_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IvrOption" ADD CONSTRAINT "IvrOption_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "IvrMenu"("id") ON DELETE CASCADE ON UPDATE CASCADE;
