-- SLA dos canais de texto e prazos dos tickets (só acrescenta valores ao enum).
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'TEXT_SLA_BELOW';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'TICKET_DUE_SOON';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'TICKET_OVERDUE';
