import { describe, it, expect } from "vitest";
import { pickOutboundTrunk } from "./tenantOutboundTrunk.js";

const COMUNICA = { tenantId: null, name: "COMUNICA", enabled: true, type: "REGISTER", authUser: "878032101000" };
const ANGO = { tenantId: "ango", name: "ANGOVOIP", enabled: true, type: "REGISTER", authUser: "878012182015" };
const FACIL_PEER = { tenantId: "facil", name: "PEER_FACIL", enabled: false, type: "PEER", authUser: null };

describe("pickOutboundTrunk", () => {
  it("cliente com tronco próprio ativo sai por ele", () => {
    expect(pickOutboundTrunk("ango", [COMUNICA, ANGO])).toEqual({ kind: "own", trunk: ANGO });
  });

  it("tronco próprio desligado: não sai, nunca cai no partilhado", () => {
    expect(pickOutboundTrunk("ango", [COMUNICA, { ...ANGO, enabled: false }])).toEqual({ kind: "own_disabled" });
  });

  it("cliente só com PEER (FÁCIL) continua no partilhado", () => {
    expect(pickOutboundTrunk("facil", [FACIL_PEER, COMUNICA])).toEqual({ kind: "shared", trunk: COMUNICA });
  });

  it("nunca usa o tronco de outro cliente", () => {
    expect(pickOutboundTrunk("facil", [ANGO, COMUNICA])).toEqual({ kind: "shared", trunk: COMUNICA });
    expect(pickOutboundTrunk(undefined, [ANGO])).toEqual({ kind: "shared", trunk: null });
  });
});
