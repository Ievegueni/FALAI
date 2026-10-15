/**
 * Chamadas de saída marcadas no telefone (teclado do webphone ou hardphone),
 * em curso — para o painel de supervisão.
 *
 * Estas chamadas não passam pela API: o dialplan faz [from-internal] → sair →
 * Dial(PJSIP/<número>@<trunk>). A API só sabe delas no fim, pelo CDR (ver
 * webphoneCdr.service.ts). Enquanto decorrem, a única fonte é o próprio
 * Asterisk: GET /channels lista também os canais fora do Stasis.
 *
 * O canal do agente (extweb_/ext_) fica no Dial até desligar e só passa a "Up"
 * quando o outro lado atende — é esse o sinal de "em conversa".
 *
 * Não há bridge ARI (a do Dial é nativa), por isso a supervisão destas chamadas
 * faz-se toda por snoop, incluindo a Intervenção (ver supervision.service.ts).
 */
import { prisma } from "@falai/db";
import { sipAuthUserFromEndpointId, type AriChannelInfo } from "@falai/providers";
import type { SupervisableCall } from "./supervision.service.js";

/** Prefixo do callId destas chamadas: ainda não há linha em Call (só no fim, pelo CDR). */
export const DIRECT_CALL_PREFIX = "pbx-";

export interface DirectChannel {
  channelId: string;
  sipAuthUser: string;
  /** Número marcado, como o dialplan o mandou para o trunk. */
  to: string | null;
}

/** Canais de agentes em conversa numa chamada marcada no telefone. */
export function directChannels(channels: AriChannelInfo[]): DirectChannel[] {
  const out: DirectChannel[] = [];
  for (const c of channels) {
    if (c.state !== "Up") continue;
    if (c.dialplan?.context !== "from-internal" || c.dialplan.app_name !== "Dial") continue;
    const endpoint = /^PJSIP\/(.+)-[0-9a-f]+$/.exec(c.name)?.[1];
    const sipAuthUser = endpoint ? sipAuthUserFromEndpointId(endpoint) : null;
    if (!sipAuthUser) continue;
    const to = /^PJSIP\/([^@,]+)@/.exec(c.dialplan.app_data ?? "")?.[1] ?? null;
    out.push({ channelId: c.id, sipAuthUser, to });
  }
  return out;
}

export interface DirectLiveCall extends SupervisableCall {
  to: string | null;
}

/**
 * Quando cada canal foi visto em conversa pela primeira vez. O ARI não dá o
 * instante do atendimento; o painel pergunta de 2 em 2 s, por isso o erro é
 * pequeno. Limpo quando o canal desaparece.
 */
const firstSeenUp = new Map<string, Date>();

export async function activeDirectCalls(
  asterisk: { listChannels(): Promise<AriChannelInfo[]> },
  tenantId: string
): Promise<DirectLiveCall[]> {
  const found = directChannels(await asterisk.listChannels());
  const alive = new Set(found.map((f) => f.channelId));
  for (const id of firstSeenUp.keys()) if (!alive.has(id)) firstSeenUp.delete(id);
  if (found.length === 0) return [];

  const exts = await prisma.extension.findMany({
    where: { tenantId, sipAuthUser: { in: found.map((f) => f.sipAuthUser) } },
    select: { id: true, sipAuthUser: true },
  });
  const extBy = new Map(exts.map((e) => [e.sipAuthUser, e.id]));
  const now = new Date();
  const out: DirectLiveCall[] = [];
  for (const f of found) {
    const extensionId = extBy.get(f.sipAuthUser);
    if (!extensionId) continue; // extensão de outro cliente
    if (!firstSeenUp.has(f.channelId)) firstSeenUp.set(f.channelId, now);
    out.push({
      tenantId,
      callId: `${DIRECT_CALL_PREFIX}${f.channelId}`,
      callerChannelId: f.channelId,
      agentChannelId: f.channelId,
      bridgeId: null,
      groupId: null,
      agentExtensionId: extensionId,
      answeredAt: firstSeenUp.get(f.channelId)!,
      to: f.to,
    });
  }
  return out;
}
