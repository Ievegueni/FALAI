-- CreateEnum
CREATE TYPE "ModelProtocol" AS ENUM ('FALAI_TURN', 'OPENAI_CHAT', 'ANTHROPIC_MESSAGES');

-- CreateTable
CREATE TABLE "TenantModel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "protocol" "ModelProtocol" NOT NULL DEFAULT 'FALAI_TURN',
    "modelName" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'BEARER',
    "authSecret" TEXT,
    "authHeader" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 4000,
    "maxReplyChars" INTEGER NOT NULL DEFAULT 800,
    "signingSecret" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "lastLatencyMs" INTEGER,
    "lastError" TEXT,
    "violations" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantModel_tenantId_idx" ON "TenantModel"("tenantId");

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "modelId" TEXT;

-- AlterTable
ALTER TABLE "CallTurn" ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "guardrailFlags" JSONB;

-- AddForeignKey
ALTER TABLE "TenantModel" ADD CONSTRAINT "TenantModel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "TenantModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
