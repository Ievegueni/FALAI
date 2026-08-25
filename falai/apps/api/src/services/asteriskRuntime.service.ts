/**
 * AsteriskRuntimeAdapter — Etapa 2 do docs/PLANO-INDEPENDENCIA-PBX.txt.
 *
 * Substitui o NoopTrunkRuntimeAdapter. Gera a configuração SIP do Asterisk
 * (trunks, extensões, autenticações, registos) a partir dos modelos do Falaí e
 * manda o motor recarregar por AMI.
 *
 * PORQUÊ GERAR FICHEIRO E NÃO USAR "PJSIP REALTIME":
 * A primeira tentativa foi realtime (o Asterisk a ler o PostgreSQL por ODBC).
 * Falhou por duas razões, ambas verificadas:
 *   1. O mapeamento realtime do tipo "registration" faz este build do
 *      Asterisk 20 rebentar (munmap_chunk: invalid pointer) ao carregar o
 *      módulo res_pjsip_outbound_registration.
 *   2. As tabelas vivem num schema separado ("asterisk", para o Prisma não as
 *      gerir) e a introspecção de tabelas do driver ODBC não respeita o
 *      search_path — o Asterisk não encontrava as tabelas.
 * Podíamos contornar pondo as tabelas no schema "public", mas isso faz o
 * Prisma acusar desvio do modelo e propor apagá-las.
 *
 * A geração de ficheiro dá o MESMO resultado para quem usa o produto — mexer
 * no backoffice reflecte-se no motor em segundos — com menos peças a partir.
 * A base de dados do Falaí continua a ser a única fonte de verdade; o ficheiro
 * é descartável e reescrito a cada alteração.
 *
 * LIMITAÇÃO CONHECIDA: a API e o Asterisk têm de partilhar o sistema de
 * ficheiros (hoje, o mesmo servidor). Se um dia forem para máquinas separadas,
 * isto passa a ter de ir por ARI ou por um volume partilhado.
 */
import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrunkRuntimeAdapter, PbxSyncPayload, PbxSyncResult } from "@falai/providers";
import { trunkEndpointId, extensionEndpointId, extensionWebEndpointId } from "@falai/providers";

const AMI_URL = process.env["ASTERISK_AMI_URL"] ?? "";
const AMI_USER = process.env["ASTERISK_AMI_USER"] ?? "";
const AMI_PASSWORD = process.env["ASTERISK_AMI_PASSWORD"] ?? "";
/** Pasta partilhada com o contentor do Asterisk (infra/asterisk/generated). */
const GENERATED_DIR = process.env["ASTERISK_GENERATED_DIR"] ?? "";
/**
 * Intervalo entre recarregamentos de módulos. O Asterisk não diz quando acabou
 * um reload, por isso é uma margem: 2s é folgado para o que medimos (um reload
 * isolado aplica-se em menos de 6s) e o sync corre em segundo plano, sem
 * ninguém à espera.
 */
const RELOAD_GAP_MS = 2000;

/**
 * Dono a dar aos ficheiros gerados. A API corre como root e o `mode` do
 * writeFile só se aplica quando o ficheiro é criado — um ficheiro novo fica
 * root:root 0640, que o Asterisk (que corre como `asterisk`) não consegue ler.
 * O sintoma é mudo: o #include falha e o contexto de entrada do cliente
 * simplesmente não existe, pelo que a chamada cai em "context not found".
 *
 * Resolvido a partir do /etc/passwd em vez de um uid fixo — varia por distro.
 * Devolve null se não houver utilizador `asterisk` (ambiente de dev, contentor
 * com outro nome), e aí não se toca no dono.
 */
const ASTERISK_USER = process.env["ASTERISK_SYSTEM_USER"] ?? "asterisk";
let cachedOwner: { uid: number; gid: number } | null | undefined;

async function asteriskOwner(): Promise<{ uid: number; gid: number } | null> {
  if (cachedOwner !== undefined) return cachedOwner;
  try {
    const passwd = await readFile("/etc/passwd", "utf8");
    const line = passwd.split("\n").find((l) => l.startsWith(`${ASTERISK_USER}:`));
    const parts = line?.split(":");
    const uid = Number(parts?.[2]);
    const gid = Number(parts?.[3]);
    cachedOwner = Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
  } catch {
    cachedOwner = null;
  }
  return cachedOwner;
}

/**
 * Nome do contexto de entrada de um trunk exclusivo de um cliente.
 *
 * Os identificadores do Falaí são cuid (letras, dígitos), mas o nome do
 * contexto acaba dentro de um ficheiro de configuração do Asterisk — limpa-se
 * o que não for seguro em vez de confiar no formato.
 */
export function peerContextName(tenantId: string): string {
  return `from-peer-${tenantId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Está o motor próprio configurado? Se não, o chamador fica com o Noop. */
export function isAsteriskConfigured(): boolean {
  return Boolean(AMI_URL && AMI_USER && AMI_PASSWORD && GENERATED_DIR);
}

export class AsteriskRuntimeAdapter implements TrunkRuntimeAdapter {
  constructor(private readonly log?: (msg: string, meta?: unknown) => void) {}

  async sync(payload: PbxSyncPayload): Promise<PbxSyncResult> {
    try {
      await mkdir(GENERATED_DIR, { recursive: true });
      const owner = await asteriskOwner();
      const write = async (name: string, contents: string): Promise<void> => {
        const path = join(GENERATED_DIR, name);
        await writeFile(path, contents, { mode: 0o640 });
        // Só falha quando não somos root; aí o dono já tem de estar certo de
        // fora, e rebentar aqui deixaria o motor sem configuração nenhuma.
        if (owner) await chown(path, owner.uid, owner.gid).catch(() => {});
      };

      await write("pjsip-falai.conf", this.buildConfig(payload));
      // O dialplan é estático mas precisa de saber por onde sai uma chamada.
      // Em vez de lá escrever o nome do trunk à mão, damos-lhe as variáveis.
      await write("globals-falai.conf", this.buildGlobals(payload));
      // Um contexto de entrada por cliente com trunk exclusivo. Tem de ser
      // gerado porque os clientes mudam; o resto do dialplan é estático.
      await write("extensions-falai.conf", this.buildDialplan(payload));
    } catch (err) {
      this.log?.("pbx.runtime.write_failed", { err: String(err) });
      return { ok: false, engine: "asterisk", details: `não foi possível escrever a configuração: ${String(err)}` };
    }

    const reloaded = await this.reload();
    this.log?.("pbx.runtime.sync (asterisk)", {
      trunks: payload.trunks.length,
      extensions: payload.extensions.length,
      reloaded,
    });

    // Escrever sem recarregar deixa o motor a correr configuração velha. Isso é
    // uma falha, não um aviso: quem mexeu no backoffice tem de saber.
    return {
      ok: reloaded,
      engine: "asterisk",
      details: reloaded
        ? "configuração aplicada e motor recarregado"
        : "configuração escrita, mas o motor NÃO recarregou — continua a usar a anterior",
    };
  }

  /** Variáveis que o dialplan usa para saber por onde sair. */
  private buildGlobals(payload: PbxSyncPayload): string {
    const trunk = payload.trunks.find((t) => t.enabled);
    return [
      "; GERADO PELA API DO FALAÍ — NÃO EDITAR À MÃO.",
      "; Incluído por extensions.conf. Sem isto o dialplan não sabe o nome do",
      "; endpoint do trunk e as chamadas de saída falham com 'endpoint not found'.",
      "TRUNK_ENDPOINT=" + (trunk ? trunkEndpointId(trunk.name) : ""),
      "TRUNK_USER=" + (trunk?.authUser ?? ""),
      "",
    ].join("\n");
  }

  /**
   * Contextos de entrada dos trunks exclusivos de clientes (peering por IP).
   *
   * Cada um faz o mesmo que o `[from-trunk]` partilhado, com uma diferença que
   * é o objectivo todo: passa o `tenantId` ao Stasis. A API passa a saber de
   * quem é a chamada pelo caminho por onde entrou, em vez de o adivinhar pelo
   * DID — que num peering com numeração interna colide entre clientes.
   */
  private buildDialplan(payload: PbxSyncPayload): string {
    const tenantIds = [
      ...new Set(payload.trunks.filter((t) => t.enabled && t.tenantId).map((t) => t.tenantId!)),
    ];

    const L: string[] = [
      ";==============================================================================",
      "; GERADO PELA API DO FALAÍ — NÃO EDITAR À MÃO.",
      "; Contextos de entrada dos trunks exclusivos de cada cliente.",
      `; Última actualização: ${new Date().toISOString()}`,
      ";==============================================================================",
      "",
    ];

    if (tenantIds.length === 0) {
      L.push("; Nenhum cliente com trunk exclusivo. Só o [from-trunk] partilhado está em uso.", "");
      return L.join("\n");
    }

    for (const tenantId of tenantIds) {
      L.push(
        `[${peerContextName(tenantId)}]`,
        `exten => _.,1,NoOp(ENTRADA do cliente ${tenantId}: de \${CALLERID(num)} para \${EXTEN})`,
        // O quarto argumento é o que distingue isto do contexto partilhado.
        ` same => n,Stasis(falai,inbound,\${EXTEN},${tenantId})`,
        ` same => n,NoOp(Stasis terminou: \${STASISSTATUS})`,
        ` same => n,GotoIf($["\${STASISSTATUS}" = "SUCCESS"]?fim)`,
        // Mesma rede de segurança do contexto partilhado: com a API em baixo a
        // chamada não morre em silêncio.
        " same => n,Answer()",
        " same => n,Playback(demo-echotest)",
        " same => n,Echo()",
        " same => n(fim),Hangup()",
        "",
      );
    }

    return L.join("\n");
  }

  /** Traduz a configuração do Falaí para a sintaxe do PJSIP. */
  private buildConfig(payload: PbxSyncPayload): string {
    const L: string[] = [
      ";==============================================================================",
      "; GERADO PELA API DO FALAÍ — NÃO EDITAR À MÃO.",
      "; Reescrito a cada alteração de trunk ou extensão. A fonte de verdade é a",
      "; base de dados do Falaí (modelos Trunk e Extension).",
      `; Última actualização: ${new Date().toISOString()}`,
      ";==============================================================================",
      "",
    ];

    for (const t of payload.trunks) {
      if (!t.enabled) continue;
      const id = trunkEndpointId(t.name);
      const auth = `${id}_auth`;
      // ALAW primeiro: o G.729 poupa banda mas degrada a transcrição da IA.
      const codecs = t.codecs.length > 0 ? t.codecs.join(",") : "alaw,ulaw";
      const dtmf = (t.dtmfMode || "rfc4733").toLowerCase();

      // Peering por IP: as duas pontas conhecem-se pelo endereço, não há
      // utilizador nem senha. Emitir um bloco `type=auth` vazio faria o PJSIP
      // exigir autenticação numa ligação que, por desenho, não a tem — o
      // operador do outro lado veria 401 em cada INVITE.
      const isPeer = t.type === "PEER";

      // Contexto de entrada. Um trunk exclusivo de um cliente entra no contexto
      // dele, e é assim que se sabe de quem é a chamada: pelo caminho por onde
      // entrou, não pelo DID (que se pode repetir entre clientes, e num peering
      // com numeração interna repete-se quase de certeza).
      const context = t.tenantId ? peerContextName(t.tenantId) : "from-trunk";

      L.push(`; ─── Trunk: ${t.name}${t.tenantId ? ` (exclusivo do cliente ${t.tenantId})` : " (partilhado)"} ───`);

      if (!isPeer) {
        L.push(
          `[${auth}]`,
          "type=auth",
          "auth_type=userpass",
          `username=${t.authName || t.authUser}`,
          `password=${t.authSecret}`,
          "",
        );
      }

      L.push(
        `[${id}]`,
        "type=aor",
        `contact=sip:${t.host}:${t.port}`,
        "qualify_frequency=60",
        "",
        `[${id}]`,
        "type=endpoint",
        "transport=transport-udp",
        `aors=${id}`,
        ...(isPeer ? [] : [`outbound_auth=${auth}`]),
        `context=${context}`,
        "disallow=all",
        `allow=${codecs}`,
        `dtmf_mode=${dtmf}`,
        "direct_media=no",
        "rtp_symmetric=yes",
        "force_rport=yes",
        // NÃO reescrever o Contact/route-set do operador. Num trunk quem está
        // atrás de NAT somos nós, não ele: o operador anuncia endereços
        // públicos válidos (Contact e Record-Route) e devemos usá-los tal como
        // vêm. Com rewrite_contact=yes o res_pjsip_nat reescreve o route set
        // para o endereço de ORIGEM do pacote recebido — que, com o Docker no
        // macOS, é o gateway interno (192.168.65.1). O ACK ao 200 OK ia parar
        // a esse endereço morto, o operador retransmitia o 200 OK sem parar e
        // a chamada caía por timeout logo depois de atendida. Evidência:
        //   Record-Route: <sip:87.238.224.117;lr;ep;...>
        //   ACK ... Route: <sip:192.168.65.1:16167;lr;ep;...>
        // O rewrite_contact continua ligado nas EXTENSÕES, onde é correcto —
        // aí é o softphone que está atrás de NAT.
        "rewrite_contact=no",
        `from_user=${t.authUser}`,
        `from_domain=${t.domain || t.host}`,
        "",
        // Reconhece as chamadas vindas do IP do operador como sendo deste trunk.
        // Num trunk PEER esta é a ÚNICA forma de autenticação que existe: quem
        // liga daquele endereço é ele, quem liga de outro não entra. Daí a
        // importância de `host` estar certo — ver validação em trunk.service.
        `[${id}]`,
        "type=identify",
        `endpoint=${id}`,
        `match=${t.host}`,
        ""
      );

      if (t.type === "REGISTER") {
        L.push(
          `[${id}]`,
          "type=registration",
          "transport=transport-udp",
          `outbound_auth=${auth}`,
          `server_uri=sip:${t.host}:${t.port}`,
          `client_uri=sip:${t.authUser}@${t.host}:${t.port}`,
          `contact_user=${t.authUser}`,
          "retry_interval=20",
          "forbidden_retry_interval=60",
          "expiration=3600",
          "max_retries=10",
          "line=yes",
          `endpoint=${id}`,
          ""
        );
      }
    }

    for (const e of payload.extensions) {
      // O endpoint chama-se como o UTILIZADOR SIP, não como o número: é assim
      // que o PJSIP identifica quem se regista, e é o que impede dois clientes
      // com a extensão 1000 de colidirem. Ver extensionEndpointId().
      const id = extensionEndpointId(e.sipAuthUser);
      const auth = `${id}_auth`;
      L.push(
        `; ─── Extensão ${e.number}${e.tenantName ? ` — ${e.tenantName}` : ""} ───`,
        `[${auth}]`,
        "type=auth",
        "auth_type=userpass",
        `username=${e.sipAuthUser}`,
        `password=${e.sipAuthSecret}`,
        "",
        `[${id}]`,
        "type=aor",
        `max_contacts=${e.maxIpRegs}`,
        "remove_existing=yes",
        "qualify_frequency=30",
        "",
        `[${id}]`,
        "type=endpoint",
        "transport=transport-udp",
        `aors=${id}`,
        `auth=${auth}`,
        "context=from-internal",
        "disallow=all",
        "allow=alaw,ulaw",
        "dtmf_mode=rfc4733",
        "direct_media=no",
        "rtp_symmetric=yes",
        "force_rport=yes",
        "rewrite_contact=yes",
        `callerid=${e.callerId} <${e.number}>`,
        ""
      );

      // Endpoint irmão, dedicado ao webphone (WebRTC) do CRM. Mesmo par
      // sipAuthUser/segredo (reaproveita o bloco [auth] acima), mas objecto
      // separado: webrtc=yes obriga a DTLS/ICE, que o hardphone acima não
      // fala, e um AOR partilhado faria o registo de um derrubar o outro
      // (remove_existing=yes). Ver extensionWebEndpointId().
      const webId = extensionWebEndpointId(e.sipAuthUser);
      L.push(
        `[${webId}]`,
        "type=aor",
        `max_contacts=${e.maxWebRegs}`,
        "remove_existing=yes",
        "",
        `[${webId}]`,
        "type=endpoint",
        // Sem `transport=`: o transporte WebSocket é criado dinamicamente pelo
        // res_pjsip_transport_websocket sobre o servidor HTTP (http.conf:8088).
        // Fixar um transport nomeado que não escuta em lado nenhum quebra o
        // INVITE de saída para o webphone.
        `aors=${webId}`,
        `auth=${auth}`,
        "context=from-internal",
        "webrtc=yes",
        "dtls_auto_generate_cert=yes",
        "media_encryption=dtls",
        "ice_support=yes",
        "rtcp_mux=yes",
        "use_avpf=yes",
        "direct_media=no",
        "disallow=all",
        "allow=opus,ulaw,alaw",
        "dtmf_mode=rfc4733",
        `callerid=${e.callerId} <${e.number}>`,
        ""
      );
    }

    return L.join("\n");
  }

  /**
   * Manda o Asterisk reler a configuração. Sem isto o ficheiro fica correcto
   * mas o motor continua a usar o que tem em memória.
   */
  private async reload(): Promise<boolean> {
    if (!AMI_URL) return false;
    try {
      const login = await fetch(
        `${AMI_URL}/rawman?action=login&username=${encodeURIComponent(AMI_USER)}&secret=${encodeURIComponent(AMI_PASSWORD)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) {
        this.log?.("pbx.runtime.reload_failed", { step: "login", status: login.status });
        return false;
      }

      // Três reloads, por esta ordem, e todos são necessários:
      //  - res_pjsip: relê endpoints, auths e aors.
      //  - res_pjsip_outbound_registration: sem este, um trunk REMOVIDO ou
      //    desactivado continua registado na operadora, porque o reload do
      //    res_pjsip não desmonta registos que deixaram de existir.
      //  - pbx_config: relê o dialplan, que é onde vivem as variáveis do trunk
      //    (globals-falai.conf). Sem ele, mudar de trunk não muda a saída.
      // ESPAÇADOS DE PROPÓSITO. O Asterisk trata um reload de cada vez: um
      // pedido que chegue com outro ainda em curso responde "Success" na mesma
      // e é DESCARTADO em silêncio. Enviados em rajada, os três anulavam-se e a
      // configuração nova não entrava no motor — medido a 28/07/2026, era a
      // razão de mexer no backoffice não chegar às chamadas.
      let ok = true;
      const modules = ["res_pjsip", "res_pjsip_outbound_registration", "pbx_config"];
      for (const [i, mod] of modules.entries()) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, RELOAD_GAP_MS));
        const res = await fetch(`${AMI_URL}/rawman?action=Reload&Module=${mod}`, {
          headers: { cookie },
          signal: AbortSignal.timeout(10_000),
        });
        const body = await res.text();
        if (!/Response:\s*Success/i.test(body)) {
          // Sem isto, uma falha de reload é invisível: o ficheiro fica certo, o
          // motor continua errado, e ninguém percebe porquê.
          this.log?.("pbx.runtime.reload_failed", { module: mod, response: body.slice(0, 200) });
          ok = false;
        }
      }
      return ok;
    } catch (err) {
      this.log?.("pbx.runtime.reload_failed", { err: String(err) });
      return false;
    }
  }

  /**
   * Só confirma que o AMI responde e autentica. NÃO recarrega: um health check
   * que reinicia módulos do motor a cada sondagem é uma forma discreta de
   * cortar chamadas a quem está a falar.
   */
  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (!isAsteriskConfigured()) return { ok: false, details: "motor não configurado" };
    try {
      const res = await fetch(
        `${AMI_URL}/rawman?action=login&username=${encodeURIComponent(AMI_USER)}&secret=${encodeURIComponent(AMI_PASSWORD)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      const ok = /Response:\s*Success/i.test(await res.text());
      return { ok, details: ok ? "ligação AMI" : "AMI recusou as credenciais" };
    } catch (err) {
      return { ok: false, details: `AMI inacessível: ${String(err)}` };
    }
  }
}
