-- AlterEnum
ALTER TYPE "CallKind" ADD VALUE 'INBOUND';

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "fromNumber" TEXT;
