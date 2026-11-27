-- Limite de chamadas de saída simultâneas por extensão (null = sem limite).
ALTER TABLE "Extension" ADD COLUMN "maxCalls" INTEGER;
