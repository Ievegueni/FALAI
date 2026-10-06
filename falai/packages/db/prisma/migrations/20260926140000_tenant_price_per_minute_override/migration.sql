-- Preço por minuto próprio do cliente (null = usa o do plano)
ALTER TABLE "Tenant" ADD COLUMN "pricePerMinuteOverrideCents" INTEGER;
