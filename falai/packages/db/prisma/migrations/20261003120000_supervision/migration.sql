-- Supervisão em tempo real (melhoria 4): papel SUPERVISOR, extensão do
-- utilizador, grupos do supervisor, pausa do agente, avisos e registo imutável.
-- Só aditivo.
-- CreateEnum
CREATE TYPE "SupervisionEventType" AS ENUM ('START', 'MODE', 'END');

-- CreateEnum
CREATE TYPE "SupervisionMode" AS ENUM ('LISTEN', 'WHISPER', 'BARGE');

-- AlterEnum
ALTER TYPE "TenantRole" ADD VALUE 'SUPERVISOR';

-- AlterTable
ALTER TABLE "Extension" ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "monitoringNotice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supervisionNotifyListen" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TenantUser" ADD COLUMN     "extensionId" TEXT;

-- CreateTable
CREATE TABLE "SupervisorGroup" (
    "tenantUserId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "SupervisorGroup_pkey" PRIMARY KEY ("tenantUserId","groupId")
);

-- CreateTable
CREATE TABLE "SupervisionEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" "SupervisionEventType" NOT NULL,
    "mode" "SupervisionMode",
    "supervisorId" TEXT NOT NULL,
    "agentExtensionId" TEXT,
    "agentExtension" TEXT,
    "callId" TEXT NOT NULL,
    "contactId" TEXT,
    "endReason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupervisionEvent_tenantId_at_idx" ON "SupervisionEvent"("tenantId", "at");

-- CreateIndex
CREATE INDEX "SupervisionEvent_sessionId_idx" ON "SupervisionEvent"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantUser_extensionId_key" ON "TenantUser"("extensionId");

-- AddForeignKey
ALTER TABLE "TenantUser" ADD CONSTRAINT "TenantUser_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorGroup" ADD CONSTRAINT "SupervisorGroup_tenantUserId_fkey" FOREIGN KEY ("tenantUserId") REFERENCES "TenantUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorGroup" ADD CONSTRAINT "SupervisorGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ExtensionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisionEvent" ADD CONSTRAINT "SupervisionEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Registo de supervisões imutável (auditoria / Lei 22/11): só INSERT.
CREATE FUNCTION supervision_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SupervisionEvent é imutável (só INSERT)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supervision_event_no_update_delete
  BEFORE UPDATE OR DELETE ON "SupervisionEvent"
  FOR EACH ROW EXECUTE FUNCTION supervision_event_immutable();
