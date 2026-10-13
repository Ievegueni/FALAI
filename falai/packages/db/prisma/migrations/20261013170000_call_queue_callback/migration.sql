-- Fila de espera + callback (aditiva)
CREATE TYPE "QueueCallbackStatus" AS ENUM ('PENDING', 'ASSIGNED', 'DONE', 'FAILED', 'CANCELLED');

ALTER TABLE "Tenant" ADD COLUMN "queueConfig" JSONB;

CREATE TABLE "QueueCallback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "callId" TEXT,
    "groupId" TEXT,
    "number" TEXT NOT NULL,
    "status" "QueueCallbackStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "assignedToId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QueueCallback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QueueCallback_tenantId_status_createdAt_idx" ON "QueueCallback"("tenantId", "status", "createdAt");

ALTER TABLE "QueueCallback" ADD CONSTRAINT "QueueCallback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "QueueCallback" ADD CONSTRAINT "QueueCallback_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "TenantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
