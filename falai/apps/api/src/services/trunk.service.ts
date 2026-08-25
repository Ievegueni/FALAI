/**
 * Helpers do trunk SIP (módulo PBX nativo). Serializa sem expor o segredo e
 * define os schemas partilhados entre as rotas admin (trunk partilhado) e
 * tenant (BYO). Ver docs/sip_trunk.md §1.1 e §3.
 */
import { z } from "zod";
import type { Prisma } from "@falai/db";
import { normalizeIp } from "./ipAllowlist.js";

type TrunkWithDids = Prisma.TrunkGetPayload<{ include: { dids: true } }>;

/** Serializa um trunk para a API — nunca devolve `authSecret`, só `secretSet`. */
export function serializeTrunk(trunk: TrunkWithDids) {
  return {
    id: trunk.id,
    tenantId: trunk.tenantId,
    shared: trunk.tenantId === null,
    name: trunk.name,
    enabled: trunk.enabled,
    itspTemplate: trunk.itspTemplate,
    type: trunk.type,
    transport: trunk.transport,
    host: trunk.host,
    port: trunk.port,
    domain: trunk.domain,
    authUser: trunk.authUser,
    authName: trunk.authName,
    secretSet: !!trunk.authSecret,
    outboundProxy: trunk.outboundProxy,
    codecs: trunk.codecs,
    dtmfMode: trunk.dtmfMode,
    dtmfFmtp: trunk.dtmfFmtp,
    authErrorCodes: trunk.authErrorCodes,
    authRegAttempts: trunk.authRegAttempts,
    regRetryIntervalS: trunk.regRetryIntervalS,
    callRestriction: trunk.callRestriction,
    maxConcurrent: trunk.maxConcurrent,
    voipFlags: trunk.voipFlags,
    sipHeaders: trunk.sipHeaders,
    dids: trunk.dids.map((d) => ({ id: d.id, did: d.did, name: d.name })),
    createdAt: trunk.createdAt,
    updatedAt: trunk.updatedAt,
  };
}

export const trunkCreateSchema = z.object({
  name: z.string().min(2).max(64),
  /**
   * Cliente dono do trunk. Só o backoffice o envia; a rota do tenant ignora-o
   * e usa sempre o tenant da sessão. Ausente = trunk partilhado do operador.
   */
  tenantId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  itspTemplate: z.string().max(64).optional(),
  type: z.enum(["REGISTER", "PEER"]).optional(),
  transport: z.enum(["UDP", "TCP", "TLS"]).optional(),
  host: z.string().min(3).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  domain: z.string().max(255).optional().nullable(),
  authUser: z.string().min(1).max(128),
  authName: z.string().max(128).optional().nullable(),
  // Só actualiza se enviado (permite guardar sem reescrever o segredo)
  authSecret: z.string().min(1).max(256).optional(),
  outboundProxy: z.string().max(255).optional().nullable(),
  codecs: z.array(z.string()).optional(),
  dtmfMode: z.string().max(32).optional(),
  dtmfFmtp: z.string().max(32).optional(),
  authErrorCodes: z.string().max(64).optional(),
  authRegAttempts: z.number().int().min(1).max(10).optional(),
  regRetryIntervalS: z.number().int().min(1).max(600).optional(),
  callRestriction: z.string().max(32).optional(),
  maxConcurrent: z.number().int().min(1).max(1000).optional().nullable(),
  voipFlags: z.record(z.string(), z.unknown()).optional(),
  sipHeaders: z.record(z.string(), z.unknown()).optional(),
});

export const trunkUpdateSchema = trunkCreateSchema.partial();

/**
 * Regras de autenticação de um trunk, que dependem do tipo.
 *
 * REGISTER: registamo-nos no provider com utilizador e senha — o segredo é
 * obrigatório.
 *
 * PEER: não há registo nem senha; as duas pontas conhecem-se pelo endereço.
 * Isso significa que o `host` É a autenticação — quem ligar daquele IP entra.
 * Daí exigir-se um IP literal e não um nome: um nome resolve-se, e quem
 * controlar a resolução passa a poder entrar. Devolve a mensagem de erro ou
 * null se estiver tudo bem.
 */
export function validateTrunkAuth(
  body: z.infer<typeof trunkUpdateSchema>,
  existing?: { type: string; authSecret: string | null },
): string | null {
  const type = body.type ?? existing?.type ?? "REGISTER";

  if (type === "PEER") {
    const host = body.host ?? "";
    // Na criação o host vem sempre; num update parcial pode não vir, e nesse
    // caso o que está guardado já foi validado quando entrou.
    if (host && normalizeIp(host) === null) {
      return (
        "Num trunk de peering (PEER) o host tem de ser um endereço IP, não um nome. " +
        "O endereço é a única autenticação que existe neste tipo de ligação."
      );
    }
    return null;
  }

  const hasSecret = Boolean(body.authSecret) || Boolean(existing?.authSecret);
  return hasSecret ? null : "Indique o segredo (palavra-passe) do trunk";
}

/** Constrói o objeto `data` do Prisma a partir do body validado (só campos enviados). */
export function trunkDataFromBody(
  body: z.infer<typeof trunkUpdateSchema>,
  encryptSecret: (s: string) => string,
): Prisma.TrunkUncheckedUpdateInput {
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.itspTemplate !== undefined ? { itspTemplate: body.itspTemplate } : {}),
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.transport !== undefined ? { transport: body.transport } : {}),
    ...(body.host !== undefined ? { host: body.host } : {}),
    ...(body.port !== undefined ? { port: body.port } : {}),
    ...(body.domain !== undefined ? { domain: body.domain } : {}),
    ...(body.authUser !== undefined ? { authUser: body.authUser } : {}),
    ...(body.authName !== undefined ? { authName: body.authName } : {}),
    ...(body.authSecret ? { authSecret: encryptSecret(body.authSecret) } : {}),
    ...(body.outboundProxy !== undefined ? { outboundProxy: body.outboundProxy } : {}),
    ...(body.codecs !== undefined ? { codecs: body.codecs } : {}),
    ...(body.dtmfMode !== undefined ? { dtmfMode: body.dtmfMode } : {}),
    ...(body.dtmfFmtp !== undefined ? { dtmfFmtp: body.dtmfFmtp } : {}),
    ...(body.authErrorCodes !== undefined ? { authErrorCodes: body.authErrorCodes } : {}),
    ...(body.authRegAttempts !== undefined ? { authRegAttempts: body.authRegAttempts } : {}),
    ...(body.regRetryIntervalS !== undefined ? { regRetryIntervalS: body.regRetryIntervalS } : {}),
    ...(body.callRestriction !== undefined ? { callRestriction: body.callRestriction } : {}),
    ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {}),
    ...(body.voipFlags !== undefined ? { voipFlags: body.voipFlags as Prisma.InputJsonValue } : {}),
    ...(body.sipHeaders !== undefined ? { sipHeaders: body.sipHeaders as Prisma.InputJsonValue } : {}),
  };
}
