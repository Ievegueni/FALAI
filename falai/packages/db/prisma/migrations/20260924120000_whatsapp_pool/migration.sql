-- CreateEnum
CREATE TYPE "WaPoolStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'STANDBY', 'FAILED', 'DISABLED');

-- AlterTable
ALTER TABLE "Inbox" ADD COLUMN     "waFailCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "waLastCheckAt" TIMESTAMP(3),
ADD COLUMN     "waLastError" TEXT,
ADD COLUMN     "waPriority" INTEGER,
ADD COLUMN     "waStatus" "WaPoolStatus",
ADD COLUMN     "waStatusAt" TIMESTAMP(3);

-- Números WhatsApp existentes entram no pool: o mais antigo de cada tenant fica ACTIVE.
UPDATE "Inbox" i SET
  "waPriority" = r.rn,
  "waStatus" = (CASE WHEN r.rn = 1 THEN 'ACTIVE' ELSE 'STANDBY' END)::"WaPoolStatus",
  "waStatusAt" = NOW()
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "tenantId" ORDER BY "createdAt") AS rn
  FROM "Inbox" WHERE channel = 'WHATSAPP' AND "deletedAt" IS NULL
) r
WHERE i.id = r.id;

-- Nunca dois números "em serviço" no mesmo tenant (o Prisma não exprime índices parciais).
CREATE UNIQUE INDEX "Inbox_one_active_wa" ON "Inbox" ("tenantId")
  WHERE "waStatus" IN ('ACTIVE', 'DEGRADED') AND "deletedAt" IS NULL;
