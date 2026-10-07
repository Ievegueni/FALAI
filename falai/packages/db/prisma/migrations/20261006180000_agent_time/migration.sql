-- Pausas com motivo, sessões e turnos dos agentes (centro de atendimento, fase 5). Só aditivo.
-- CreateTable
CREATE TABLE "PauseReason" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PauseReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPause" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "userId" TEXT,
    "reasonId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentPause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PauseReason_tenantId_label_key" ON "PauseReason"("tenantId", "label");

-- CreateIndex
CREATE INDEX "AgentPause_tenantId_startedAt_idx" ON "AgentPause"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentPause_extensionId_endedAt_idx" ON "AgentPause"("extensionId", "endedAt");

-- CreateIndex
CREATE INDEX "AgentSession_tenantId_startedAt_idx" ON "AgentSession"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentSession_userId_endedAt_idx" ON "AgentSession"("userId", "endedAt");

-- CreateIndex
CREATE INDEX "Shift_tenantId_userId_idx" ON "Shift"("tenantId", "userId");

-- AddForeignKey
ALTER TABLE "PauseReason" ADD CONSTRAINT "PauseReason_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPause" ADD CONSTRAINT "AgentPause_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPause" ADD CONSTRAINT "AgentPause_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPause" ADD CONSTRAINT "AgentPause_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TenantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPause" ADD CONSTRAINT "AgentPause_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "PauseReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TenantUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "TenantUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

