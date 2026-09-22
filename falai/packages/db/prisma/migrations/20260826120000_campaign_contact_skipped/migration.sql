-- Estado para contactos que nunca foram tentados (campanha cancelada ou
-- contacto removido). Antes eram marcados FAILED, o que distorcia a taxa de
-- insucesso dos relatórios.
ALTER TYPE "CampaignContactStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';
