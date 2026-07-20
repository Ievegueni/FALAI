-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('PER_MINUTE', 'PER_SECOND', 'PER_CALL');

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "billingMode" "BillingMode" NOT NULL DEFAULT 'PER_MINUTE';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "billingModeOverride" "BillingMode";
