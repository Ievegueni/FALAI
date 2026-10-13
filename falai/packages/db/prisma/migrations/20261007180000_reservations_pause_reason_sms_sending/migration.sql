-- Reserva de saldo das chamadas persistida (antes só em memória no CallEngine).
ALTER TABLE "Call" ADD COLUMN "reservedCents" INTEGER NOT NULL DEFAULT 0;

-- Motivo da pausa de campanha: o carregamento de saldo só retoma as LOW_BALANCE.
ALTER TABLE "Campaign" ADD COLUMN "pausedReason" TEXT;

-- SMS reclamado para envio (saldo reservado), para o despacho ser idempotente.
ALTER TYPE "SmsStatus" ADD VALUE 'SENDING' AFTER 'QUEUED';
