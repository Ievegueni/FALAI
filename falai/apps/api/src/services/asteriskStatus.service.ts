/**
 * Estado do motor SIP próprio (Asterisk) — Etapa 3 do docs/PLANO-INDEPENDENCIA-PBX.txt.
 *
 * Lê o estado do registo do trunk através do AMI sobre HTTP. O ARI não expõe
 * registos de saída; o AMI expõe. Quando a Etapa 3 avançar para originar
 * chamadas, isso passa pelo ARI — os dois canais coexistem por desenho.
 *
 * Tolerante a falhas: se o Asterisk não estiver a correr (que é o caso normal
 * hoje, em que o motor ainda é opcional), devolve estado "desligado" em vez de
 * rebentar. Nunca deve derrubar o backoffice.
 */

export type TrunkRegistrationStatus = "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN";

export interface AsteriskTrunkStatus {
  name: string;
  status: TrunkRegistrationStatus;
  serverUri: string | null;
  username: string | null;
  /** Segundos até expirar o registo, quando o Asterisk o reporta. */
  expirationSecs: number | null;
}

/** Resposta ao último OPTIONS que mandámos ao outro lado. */
export type PeerReachability = "REACHABLE" | "UNREACHABLE" | "UNKNOWN";

/**
 * Estado de um trunk de peering (IP-to-IP).
 *
 * Um trunk PEER não se regista — é essa a natureza dele — por isso nunca
 * aparece na lista de registos de saída e não há um "REGISTERED" para mostrar.
 * O sinal de vida equivalente é o qualify: o Asterisk manda um OPTIONS de
 * 60 em 60 segundos (qualify_frequency no AOR gerado) e guarda se houve
 * resposta e quanto demorou. Sem isto não havia forma nenhuma de saber que o
 * peering de um cliente caiu, a não ser quando ele telefonasse a reclamar.
 */
export interface AsteriskPeerStatus {
  /** Nome do endpoint PJSIP (trunk_<NOME>). */
  endpoint: string;
  /** Nome do trunk como aparece no backoffice. */
  trunkName: string;
  /** Cliente dono, quando é um trunk exclusivo. */
  tenantId: string | null;
  /** IP configurado do outro lado. */
  host: string;
  status: PeerReachability;
  /** URI do contacto que o Asterisk sondou. */
  uri: string | null;
  /** Latência do último OPTIONS, em milissegundos. */
  latencyMs: number | null;
}

export interface AsteriskStatus {
  /** false = motor não configurado ou inacessível. */
  engineReachable: boolean;
  /** Versão do Asterisk, quando acessível. */
  version: string | null;
  trunks: AsteriskTrunkStatus[];
  /** Trunks de peering (IP-to-IP), que não têm registo — ver AsteriskPeerStatus. */
  peers: AsteriskPeerStatus[];
  activeCalls: number | null;
  /** Mensagem legível quando algo falha — mostrada na UI. */
  error: string | null;
  checkedAt: string;
}

/** O que o chamador tem de dizer sobre cada trunk PEER a sondar. */
export interface PeerTrunkRef {
  endpoint: string;
  trunkName: string;
  tenantId: string | null;
  host: string;
}

const AMI_URL = process.env["ASTERISK_AMI_URL"] ?? "";
const AMI_USER = process.env["ASTERISK_AMI_USER"] ?? "";
const AMI_PASSWORD = process.env["ASTERISK_AMI_PASSWORD"] ?? "";
const TIMEOUT_MS = 4000;

function offline(error: string): AsteriskStatus {
  return {
    engineReachable: false,
    version: null,
    trunks: [],
    peers: [],
    activeCalls: null,
    error,
    checkedAt: new Date().toISOString(),
  };
}

function mapReachability(raw: string | undefined): PeerReachability {
  if (!raw) return "UNKNOWN";
  const v = raw.toLowerCase();
  if (v === "reachable" || v === "created" || v === "updated") return "REACHABLE";
  // NonQualified aparece quando o qualify está desligado: não sabemos, e dizer
  // "inalcançável" seria mentir sobre um trunk que pode estar perfeitamente bom.
  if (v === "nonqualified" || v === "unknown") return "UNKNOWN";
  return "UNREACHABLE";
}

async function amiRequest(path: string, cookie?: string): Promise<{ body: string; cookie: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${AMI_URL}${path}`, {
      signal: controller.signal,
      headers: cookie ? { cookie } : {},
    });
    const body = await res.text();
    // O AMI devolve a sessão em set-cookie; guardamos só o par mxid.
    const setCookie = res.headers.get("set-cookie");
    return { body, cookie: setCookie ? (setCookie.split(";")[0] ?? null) : null };
  } finally {
    clearTimeout(timer);
  }
}

/** Divide a resposta do AMI em blocos de eventos (pares chave: valor). */
function parseEvents(body: string): Array<Record<string, string>> {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const rec: Record<string, string> = {};
      for (const line of block.split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx > 0) rec[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      return rec;
    })
    .filter((r) => Object.keys(r).length > 0);
}

function mapStatus(raw: string | undefined): TrunkRegistrationStatus {
  if (!raw) return "UNKNOWN";
  const v = raw.toLowerCase();
  if (v === "registered") return "REGISTERED";
  // Rejected, Unregistered, Stopped, Failed… — tudo o que não é registado.
  if (["rejected", "unregistered", "stopped", "failed", "no auth"].includes(v)) return "NOT_REGISTERED";
  return "UNKNOWN";
}

/**
 * Estado actual do motor. Nunca lança — devolve sempre um objecto utilizável
 * para a UI poder distinguir "não configurado" de "configurado mas em baixo".
 */
export async function getAsteriskStatus(peerTrunks: PeerTrunkRef[] = []): Promise<AsteriskStatus> {
  if (!AMI_URL || !AMI_USER || !AMI_PASSWORD) {
    return offline("Motor SIP próprio ainda não configurado (ASTERISK_AMI_* em falta).");
  }

  try {
    const login = await amiRequest(
      `/rawman?action=login&username=${encodeURIComponent(AMI_USER)}&secret=${encodeURIComponent(AMI_PASSWORD)}`
    );
    if (!/Response:\s*Success/i.test(login.body)) {
      return offline("Autenticação no motor SIP recusada — verificar ASTERISK_AMI_USER/PASSWORD.");
    }
    const cookie = login.cookie ?? undefined;

    const [regs, core, settings] = await Promise.all([
      amiRequest("/rawman?action=PJSIPShowRegistrationsOutbound", cookie),
      amiRequest("/rawman?action=CoreStatus", cookie),
      amiRequest("/rawman?action=CoreSettings", cookie),
    ]);

    const trunks: AsteriskTrunkStatus[] = parseEvents(regs.body)
      .filter((e) => e["Event"] === "OutboundRegistrationDetail")
      .map((e) => ({
        name: e["ObjectName"] ?? "trunk",
        status: mapStatus(e["Status"]),
        serverUri: e["ServerUri"] ?? null,
        // O utilizador vem no evento AuthDetail, separado deste. Extraímo-lo do
        // ClientUri (sip:UTILIZADOR@servidor) para não ter de correlacionar
        // eventos — é o mesmo valor e está sempre presente.
        username: /sip:([^@]+)@/.exec(e["ClientUri"] ?? "")?.[1] ?? null,
        expirationSecs: e["Expiration"] ? Number(e["Expiration"]) : null,
      }));

    // Um pedido por trunk PEER: o ContactStatusDetail só vem no
    // PJSIPShowEndpoint singular — a versão plural devolve apenas a lista de
    // nomes. São poucos (um por cliente de peering), por isso vão em paralelo.
    const peers: AsteriskPeerStatus[] = await Promise.all(
      peerTrunks.map(async (t) => {
        const base = { endpoint: t.endpoint, trunkName: t.trunkName, tenantId: t.tenantId, host: t.host };
        try {
          const res = await amiRequest(
            `/rawman?action=PJSIPShowEndpoint&Endpoint=${encodeURIComponent(t.endpoint)}`,
            cookie
          );
          const contact = parseEvents(res.body).find((e) => e["Event"] === "ContactStatusDetail");
          if (!contact) return { ...base, status: "UNKNOWN" as const, uri: null, latencyMs: null };
          const usec = Number(contact["RoundtripUsec"]);
          return {
            ...base,
            status: mapReachability(contact["Status"]),
            uri: contact["URI"] ?? null,
            // O Asterisk dá microssegundos; 0 significa "sem medição", não 0ms.
            latencyMs: Number.isFinite(usec) && usec > 0 ? Math.round(usec / 1000) : null,
          };
        } catch {
          // Um trunk que não responde não pode derrubar o cartão inteiro.
          return { ...base, status: "UNKNOWN" as const, uri: null, latencyMs: null };
        }
      })
    );

    const coreEvent = parseEvents(core.body).find((e) => e["CoreCurrentCalls"] !== undefined);
    // A versão vem do CoreSettings (AsteriskVersion), não do CoreStatus.
    const version = /AsteriskVersion:\s*([^\s~]+)/i.exec(settings.body)?.[1] ?? null;

    return {
      engineReachable: true,
      version,
      trunks,
      peers,
      activeCalls: coreEvent?.["CoreCurrentCalls"] ? Number(coreEvent["CoreCurrentCalls"]) : null,
      error: null,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "sem resposta (timeout)" : String(err);
    return offline(`Motor SIP inacessível: ${msg}`);
  }
}
