-- O IVR de 20260912120000_add_ivr_menus (IvrMenu + IvrOption, saudação por
-- ficheiro de som) foi substituído pelo de 20260925120000_ivr_menu (saudação
-- por TTS, opções em JSON). Nunca chegou a ter menus em produção.
--
-- Salvaguarda: se alguma das tabelas existir e tiver linhas, a migração pára
-- aqui em vez de apagar dados. Migrar/exportar à mão antes de voltar a correr.
DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('"IvrOption"') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM "IvrOption"' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'drop_legacy_ivr: "IvrOption" tem % linha(s) — migrar esses dados antes de apagar a tabela', n;
    END IF;
  END IF;
  IF to_regclass('"IvrMenu"') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM "IvrMenu"' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'drop_legacy_ivr: "IvrMenu" tem % linha(s) — migrar esses dados antes de apagar a tabela', n;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS "IvrOption";
DROP TABLE IF EXISTS "IvrMenu";
