-- CreateEnum
CREATE TYPE "TelephonyEngine" AS ENUM ('YEASTAR', 'ASTERISK');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "telephonyEngine" "TelephonyEngine" NOT NULL DEFAULT 'YEASTAR';
