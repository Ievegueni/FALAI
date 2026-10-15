-- Atendimento automático por extensão (definido pelo administrador). Aditiva: false para todas.
ALTER TABLE "Extension" ADD COLUMN "autoAnswer" BOOLEAN NOT NULL DEFAULT false;
