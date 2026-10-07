-- Tickets (centro de atendimento, fase 1) — ver docs/PLANO-CENTRO-ATENDIMENTO.md. Só aditivo.
-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketEventType" AS ENUM ('CREATED', 'STATUS', 'PRIORITY', 'LEVEL', 'ASSIGNEE', 'GROUP', 'CATEGORY', 'SUBJECT', 'NOTE', 'LINKED', 'UNLINKED');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "ticketSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "supportLevel" INTEGER NOT NULL DEFAULT 1,
    "categoryId" TEXT,
    "subcategoryId" TEXT,
    "contactId" TEXT,
    "assigneeId" TEXT,
    "groupId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "dueAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "externalSystem" TEXT,
    "externalId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "type" "TicketEventType" NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "body" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Ticket_tenantId_status_updatedAt_idx" ON "Ticket"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Ticket_tenantId_assigneeId_status_idx" ON "Ticket"("tenantId", "assigneeId", "status");

-- CreateIndex
CREATE INDEX "Ticket_tenantId_contactId_idx" ON "Ticket"("tenantId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_tenantId_number_key" ON "Ticket"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_tenantId_externalSystem_externalId_key" ON "Ticket"("tenantId", "externalSystem", "externalId");

-- CreateIndex
CREATE INDEX "TicketEvent_ticketId_createdAt_idx" ON "TicketEvent"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "Call_ticketId_idx" ON "Call"("ticketId");

-- CreateIndex
CREATE INDEX "Conversation_ticketId_idx" ON "Conversation"("ticketId");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CallCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "CallCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "TenantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ExtensionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "TenantUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

