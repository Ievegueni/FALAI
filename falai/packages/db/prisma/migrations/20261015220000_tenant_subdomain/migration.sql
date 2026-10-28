-- Endereço próprio do tenant no CRM (ex.: credito.falai.ao). Aditiva: null para todos.
ALTER TABLE "Tenant" ADD COLUMN "subdomain" TEXT;
CREATE UNIQUE INDEX "Tenant_subdomain_key" ON "Tenant"("subdomain");
