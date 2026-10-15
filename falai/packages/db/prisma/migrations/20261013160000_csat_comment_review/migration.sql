-- Satisfação: comentário do cliente nas notas baixas e tratamento pela supervisão (só acrescenta colunas e um índice).
ALTER TABLE "CsatResponse" ADD COLUMN "comment" TEXT;
ALTER TABLE "CsatResponse" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "CsatResponse" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "CsatResponse" ADD COLUMN "reviewNote" TEXT;
CREATE INDEX "CsatResponse_tenantId_score_reviewedAt_idx" ON "CsatResponse"("tenantId", "score", "reviewedAt");
