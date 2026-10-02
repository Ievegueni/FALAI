-- Tipificação de chamadas (melhoria 2): categorias/subcategorias por tenant,
-- associação a grupos, tipificação na perna atendida e config do tenant. Só aditivo.
-- AlterTable
ALTER TABLE "CallLeg" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "subcategoryId" TEXT,
ADD COLUMN     "typedAt" TIMESTAMP(3),
ADD COLUMN     "typedById" TEXT,
ADD COLUMN     "typingNote" TEXT,
ADD COLUMN     "wrapUpEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "typingMaxSecs" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "typingRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CallCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallCategoryGroup" (
    "categoryId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "CallCategoryGroup_pkey" PRIMARY KEY ("categoryId","groupId")
);

-- CreateIndex
CREATE INDEX "CallCategory_tenantId_idx" ON "CallCategory"("tenantId");

-- CreateIndex
CREATE INDEX "CallLeg_extensionId_wrapUpEndsAt_idx" ON "CallLeg"("extensionId", "wrapUpEndsAt");

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CallCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "CallCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallCategory" ADD CONSTRAINT "CallCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallCategory" ADD CONSTRAINT "CallCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CallCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallCategoryGroup" ADD CONSTRAINT "CallCategoryGroup_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CallCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallCategoryGroup" ADD CONSTRAINT "CallCategoryGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ExtensionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

