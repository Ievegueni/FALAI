-- O IVR de 20260912120000_add_ivr_menus (IvrMenu + IvrOption, saudação por
-- ficheiro de som) foi substituído pelo de 20260925120000_ivr_menu (saudação
-- por TTS, opções em JSON). Nunca chegou a ter menus em produção.
DROP TABLE "IvrOption";
DROP TABLE "IvrMenu";
