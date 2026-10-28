import { describe, it, expect, vi } from "vitest";

vi.mock("@falai/db", () => ({ prisma: {} }));
const { directChannels } = await import("./directLiveCalls.service.js");

const ch = (o: Partial<{ id: string; name: string; state: string; context: string; app: string; data: string }>) => ({
  id: o.id ?? "1791317923.23",
  name: o.name ?? "PJSIP/extweb_6PRQNJRSKZ-0000000c",
  state: o.state ?? "Up",
  creationtime: "2026-10-06T21:18:43.000+0100",
  dialplan: { context: o.context ?? "from-internal", exten: "sair", app_name: o.app ?? "Dial", app_data: o.data ?? "PJSIP/924572875@trunk_COMUNICA,60" },
});

describe("directChannels — chamadas marcadas no telefone, em conversa", () => {
  it("canal do webphone no Dial e atendido: extensão e número marcado", () => {
    expect(directChannels([ch({})])).toEqual([{ channelId: "1791317923.23", sipAuthUser: "6PRQNJRSKZ", to: "924572875" }]);
  });

  it("hardphone (ext_) também conta", () => {
    expect(directChannels([ch({ name: "PJSIP/ext_Ab12-0000001f" })])[0]?.sipAuthUser).toBe("Ab12");
  });

  it("ignora: ainda a tocar, a perna do trunk, canais do Stasis e outros contextos", () => {
    expect(
      directChannels([
        ch({ state: "Ring" }),
        ch({ name: "PJSIP/trunk_COMUNICA-0000000d", context: "from-trunk", app: "AppDial", data: "(Outgoing Line)" }),
        ch({ app: "Stasis", data: "falai,inbound,878032101000" }),
        ch({ context: "from-peer-x" }),
      ])
    ).toEqual([]);
  });
});
