-- AlterEnum
ALTER TYPE "ProductType" ADD VALUE 'API_BYOM';

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "allowedCidrs" TEXT[] DEFAULT ARRAY[]::TEXT[];
