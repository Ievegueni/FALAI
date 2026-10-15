-- CreateTable
CREATE TABLE "ProviderTopUp" (
    "id" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderTopUp_pkey" PRIMARY KEY ("id")
);
