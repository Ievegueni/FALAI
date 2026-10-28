-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "recordCalls" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recordingAnnounce" BOOLEAN NOT NULL DEFAULT false;
