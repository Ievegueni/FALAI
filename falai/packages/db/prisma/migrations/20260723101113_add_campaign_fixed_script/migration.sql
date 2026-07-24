-- CreateEnum
CREATE TYPE "CampaignMode" AS ENUM ('VOICE_AI', 'FIXED_SCRIPT');

-- DropForeignKey
ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_agentId_fkey";

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "mode" "CampaignMode" NOT NULL DEFAULT 'VOICE_AI',
ADD COLUMN     "scriptText" TEXT,
ADD COLUMN     "ttsVoiceId" TEXT,
ALTER COLUMN "agentId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
