-- CreateEnum
CREATE TYPE "TrunkType" AS ENUM ('REGISTER', 'PEER');

-- CreateEnum
CREATE TYPE "SipTransport" AS ENUM ('UDP', 'TCP', 'TLS');

-- CreateTable
CREATE TABLE "Trunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "itspTemplate" TEXT NOT NULL DEFAULT 'GENERIC',
    "type" "TrunkType" NOT NULL DEFAULT 'REGISTER',
    "transport" "SipTransport" NOT NULL DEFAULT 'UDP',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 5060,
    "domain" TEXT,
    "authUser" TEXT NOT NULL,
    "authName" TEXT,
    "authSecret" TEXT NOT NULL,
    "outboundProxy" TEXT,
    "codecs" TEXT[],
    "dtmfMode" TEXT NOT NULL DEFAULT 'RFC4733',
    "dtmfFmtp" TEXT NOT NULL DEFAULT '0-16',
    "authErrorCodes" TEXT NOT NULL DEFAULT '401;407;403',
    "authRegAttempts" INTEGER NOT NULL DEFAULT 3,
    "regRetryIntervalS" INTEGER NOT NULL DEFAULT 20,
    "callRestriction" TEXT NOT NULL DEFAULT 'OUTBOUND',
    "maxConcurrent" INTEGER,
    "voipFlags" JSONB,
    "sipHeaders" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrunkDid" (
    "id" TEXT NOT NULL,
    "trunkId" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "TrunkDid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "displayName" TEXT,
    "email" TEXT,
    "mobile" TEXT,
    "roleId" TEXT,
    "sipAuthUser" TEXT NOT NULL,
    "sipAuthSecret" TEXT NOT NULL,
    "maxIpRegs" INTEGER NOT NULL DEFAULT 4,
    "maxWebRegs" INTEGER NOT NULL DEFAULT 3,
    "presence" JSONB,
    "voicemail" JSONB,
    "features" JSONB,
    "voip" JSONB,
    "security" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "phoneNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB,

    CONSTRAINT "ExtensionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionGroupMember" (
    "extensionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "ExtensionGroupMember_pkey" PRIMARY KEY ("extensionId","groupId")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundRoute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trunkId" TEXT NOT NULL,
    "dialPattern" TEXT,
    "callerId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboundRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundRoutePermission" (
    "routeId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,

    CONSTRAINT "OutboundRoutePermission_pkey" PRIMARY KEY ("routeId","extensionId")
);

-- CreateTable
CREATE TABLE "InboundRoute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trunkId" TEXT NOT NULL,
    "didPattern" TEXT NOT NULL,
    "destType" TEXT NOT NULL,
    "destValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trunk_tenantId_idx" ON "Trunk"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TrunkDid_trunkId_did_key" ON "TrunkDid"("trunkId", "did");

-- CreateIndex
CREATE UNIQUE INDEX "Extension_sipAuthUser_key" ON "Extension"("sipAuthUser");

-- CreateIndex
CREATE INDEX "Extension_tenantId_idx" ON "Extension"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Extension_tenantId_number_key" ON "Extension"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionGroup_tenantId_name_key" ON "ExtensionGroup"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_name_key" ON "Role"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundRoute_tenantId_name_key" ON "OutboundRoute"("tenantId", "name");

-- CreateIndex
CREATE INDEX "InboundRoute_tenantId_idx" ON "InboundRoute"("tenantId");

-- AddForeignKey
ALTER TABLE "Trunk" ADD CONSTRAINT "Trunk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrunkDid" ADD CONSTRAINT "TrunkDid_trunkId_fkey" FOREIGN KEY ("trunkId") REFERENCES "Trunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionGroup" ADD CONSTRAINT "ExtensionGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionGroupMember" ADD CONSTRAINT "ExtensionGroupMember_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionGroupMember" ADD CONSTRAINT "ExtensionGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ExtensionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRoute" ADD CONSTRAINT "OutboundRoute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRoute" ADD CONSTRAINT "OutboundRoute_trunkId_fkey" FOREIGN KEY ("trunkId") REFERENCES "Trunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRoutePermission" ADD CONSTRAINT "OutboundRoutePermission_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "OutboundRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRoutePermission" ADD CONSTRAINT "OutboundRoutePermission_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundRoute" ADD CONSTRAINT "InboundRoute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundRoute" ADD CONSTRAINT "InboundRoute_trunkId_fkey" FOREIGN KEY ("trunkId") REFERENCES "Trunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

