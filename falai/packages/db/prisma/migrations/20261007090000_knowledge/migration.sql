-- Base de conhecimento (centro de atendimento, fase 10). Só aditivo.
-- CreateTable
CREATE TABLE "KbArticle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbArticle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KbArticle_tenantId_isPublished_idx" ON "KbArticle"("tenantId", "isPublished");

-- CreateIndex
CREATE INDEX "KbArticle_title_trgm_idx" ON "KbArticle" USING GIN ("title" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "KbArticle" ADD CONSTRAINT "KbArticle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

