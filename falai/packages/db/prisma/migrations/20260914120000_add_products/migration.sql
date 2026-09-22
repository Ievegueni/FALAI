-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "productId" TEXT;

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseType" "ProductType" NOT NULL DEFAULT 'VOICE_AI',
    "aiAgentsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "clinicEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "monthlyFeeCents" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Os três produtos que já existiam como tipo fixo passam a ser linhas do
-- catálogo, e os planos actuais ficam ligados ao produto do seu tipo.
INSERT INTO "Product" ("id", "name", "description", "baseType", "aiAgentsEnabled", "updatedAt") VALUES
  ('prod_voice_ai', 'Operador (PBX + IA)', 'PBX e IA da plataforma, faturado por minuto.', 'VOICE_AI', true, CURRENT_TIMESTAMP),
  ('prod_crm_byo_pbx', 'CRM (PBX do cliente)', 'Só CRM: o cliente liga o PBX Yeastar dele.', 'CRM_BYO_PBX', false, CURRENT_TIMESTAMP),
  ('prod_api_byom', 'API (modelo do cliente)', 'Só API: o cliente tem o CRM e o modelo dele.', 'API_BYOM', true, CURRENT_TIMESTAMP);

UPDATE "Plan" SET "productId" = CASE "productType"
  WHEN 'VOICE_AI' THEN 'prod_voice_ai'
  WHEN 'CRM_BYO_PBX' THEN 'prod_crm_byo_pbx'
  WHEN 'API_BYOM' THEN 'prod_api_byom'
END;
