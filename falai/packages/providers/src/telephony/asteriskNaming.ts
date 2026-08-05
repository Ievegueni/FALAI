/**
 * Nomes dos objectos PJSIP e formato dos números marcados.
 *
 * Vive aqui — e não no serviço que gera a configuração — porque há duas peças
 * que TÊM de concordar sobre o mesmo nome:
 *   - `asteriskRuntime.service` (API), que escreve o `pjsip-falai.conf`;
 *   - `AsteriskAdapter` (este pacote), que marca `PJSIP/<numero>@<endpoint>`.
 * Se divergirem, o Asterisk responde "endpoint not found" e a chamada nunca sai.
 */

/** Nome seguro para um objecto PJSIP: sem espaços, acentos ou pontuação. */
function safe(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
}

/** Endpoint do trunk do operador. Deriva do nome do trunk (ex.: "TESTE.ANGOLA.AGV"). */
export function trunkEndpointId(trunkName: string): string {
  return `trunk_${safe(trunkName)}`;
}

/**
 * Endpoint de uma extensão. Usa o UTILIZADOR SIP e não o número da extensão,
 * por duas razões:
 *   1. o PJSIP identifica quem se regista comparando o utilizador do URI com o
 *      NOME do endpoint (`endpoint_identifier_order=...,username,...`). Se o
 *      endpoint se chamasse "1000" e o softphone se registasse com o
 *      utilizador "FAWFyFTRBv", o registo era rejeitado;
 *   2. o número repete-se entre clientes (todos têm uma extensão 1000) e o
 *      ficheiro de configuração é global — dois clientes colidiam.
 */
export function extensionEndpointId(sipAuthUser: string): string {
  return `ext_${safe(sipAuthUser)}`;
}

/**
 * Endpoint WebRTC (webphone) da mesma extensão, separado do endpoint de
 * hardphone acima. Necessário porque `webrtc=yes` obriga a media_encryption
 * DTLS/ICE, que um hardphone UDP simples não fala — não dá para partilhar o
 * mesmo endpoint/AOR sem quebrar um dos dois lados, nem partilhar o AOR
 * (remove_existing derrubaria o registo um do outro). O par sipAuthUser/
 * segredo é o mesmo do hardphone; só o nome do objecto muda.
 */
export function extensionWebEndpointId(sipAuthUser: string): string {
  return `extweb_${safe(sipAuthUser)}`;
}

/**
 * Formato em que os números são entregues ao operador. Enquanto a ANGOVOIP não
 * confirmar qual aceita, muda-se por variável de ambiente sem tocar no código.
 *   national -> 912345678      (9 dígitos, o mais provável em Angola)
 *   cc       -> 244912345678   (indicativo sem +)
 *   e164     -> +244912345678  (norma internacional)
 */
export type DialFormat = "national" | "cc" | "e164";

const AO_CC = "244";

/** Normaliza um número angolano para o formato pedido pelo operador. */
export function formatDialNumber(raw: string, format: DialFormat = "national"): string {
  const digits = raw.replace(/[^\d]/g, "");

  // Reduz primeiro ao número nacional, venha ele em que formato vier.
  let national = digits;
  if (national.startsWith("00" + AO_CC)) national = national.slice(2 + AO_CC.length);
  else if (national.startsWith(AO_CC) && national.length > 9) national = national.slice(AO_CC.length);

  // Números que não são angolanos (ou já internacionais de outro país) passam
  // como estão: não é seguro adivinhar.
  if (national.length !== 9) return digits;

  switch (format) {
    case "e164":
      return `+${AO_CC}${national}`;
    case "cc":
      return `${AO_CC}${national}`;
    default:
      return national;
  }
}

/** Lê o formato da variável de ambiente, com aviso silencioso para valores inválidos. */
export function parseDialFormat(value: string | undefined): DialFormat {
  return value === "e164" || value === "cc" || value === "national" ? value : "national";
}
