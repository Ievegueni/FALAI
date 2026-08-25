/**
 * Resolve que motor de IA responde num agente.
 *
 * Sem `Agent.modelId` é o Claude da plataforma (comportamento de sempre, não
 * mexido). Com `modelId` é o modelo do próprio cliente, chamado por HTTP a cada
 * turno — produto API_BYOM.
 *
 * Um modelo só entra numa chamada real com `status = ACTIVE`. Um modelo em
 * DRAFT, PENDING_REVIEW, PAUSED ou BLOCKED cai para o motor da plataforma, e
 * isso fica registado: o cliente nunca fica sem serviço por causa de moderação,
 * mas também nunca põe em produção nada que não tenhamos aprovado.
 */

import { prisma } from "@falai/db";
import { RemoteModelAdapter, type LlmProvider } from "@falai/providers";
import { decryptSecret } from "./crypto.service.js";

export interface ResolvedModel {
  /** O provider a usar neste turno. Null = usar o motor da plataforma. */
  llm: LlmProvider | null;
  /** Id do TenantModel usado, para gravar em CallTurn.modelId. */
  modelId: string | null;
  /** Limite de caracteres da resposta imposto por este modelo. */
  maxReplyChars?: number;
}

const PLATFORM: ResolvedModel = { llm: null, modelId: null };

/**
 * Cache curta por agente. Uma chamada faz dezenas de turnos e não vale uma ida
 * à base de dados por turno; 30 s é curto o suficiente para um bloqueio no
 * backoffice se fazer sentir quase de imediato.
 *
 * O corte imediato de verdade não depende disto: `blockModel()` limpa a cache.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: ResolvedModel }>();

/**
 * Adaptadores vivos, por modelo. O `RemoteModelAdapter` traz um disjuntor com
 * estado interno (N falhas seguidas → abre 30s) e esse estado só serve para
 * alguma coisa se a instância sobreviver entre chamadas. Reconstruí-lo a cada
 * chamada — ou a cada expiração da cache acima — punha o contador a zero e o
 * disjuntor nunca disparava.
 *
 * A chave inclui `updatedAt` para que editar o modelo no backoffice crie uma
 * instância nova (config nova, disjuntor limpo) sem deixar a antiga a servir.
 */
const adapters = new Map<string, LlmProvider>();

/** Esquece o que está em cache. Chamar ao bloquear ou editar um modelo. */
export function invalidateModelCache(agentId?: string): void {
  if (agentId) cache.delete(agentId);
  else cache.clear();
}

/**
 * Modelos cortados nesta instância. Limpar a cache não chega: uma chamada já a
 * decorrer resolveu o modelo no arranque e guardou-o na sessão, portanto
 * continuaria a usá-lo até desligar — numa campanha de 200 chamadas com 5
 * minutos cada, o kill switch não cortava nada durante 5 minutos.
 *
 * `CallEngineService` consulta isto a cada turno, que é onde o corte tem de
 * acontecer de facto.
 *
 * Limitação conhecida: é memória deste processo. Com mais do que uma instância
 * de API, as outras só cortam quando a cache de 30s expirar. Para corte
 * imediato em cluster falta um PUBLISH no Redis (que já existe no projecto).
 */
const blocked = new Set<string>();

/** True se este modelo foi cortado — consultado a cada turno. */
export function isModelBlocked(modelId: string): boolean {
  return blocked.has(modelId);
}

/** Deita fora o adaptador de um modelo (e a resolução de quem o usa). */
export function invalidateModel(modelId: string, opts?: { blockLiveCalls?: boolean }): void {
  invalidateAdaptersFor(modelId);
  for (const [agentId, entry] of cache) {
    if (entry.value.modelId === modelId) cache.delete(agentId);
  }
  if (opts?.blockLiveCalls) blocked.add(modelId);
  else blocked.delete(modelId); // aprovar/reeditar levanta um corte anterior
}

export async function resolveModelForAgent(agentId: string): Promise<ResolvedModel> {
  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      modelId: true,
      tenantId: true,
      model: {
        select: {
          id: true, name: true, endpointUrl: true, protocol: true, modelName: true,
          authType: true, authSecret: true, authHeader: true, signingSecret: true,
          timeoutMs: true, maxReplyChars: true, status: true, deletedAt: true,
          updatedAt: true,
        },
      },
    },
  });

  const model = agent?.model;
  let resolved: ResolvedModel = PLATFORM;

  if (model && !model.deletedAt) {
    if (model.status === "ACTIVE") {
      resolved = {
        llm: getAdapter(model),
        modelId: model.id,
        maxReplyChars: model.maxReplyChars,
      };
    } else {
      // Não é um erro do cliente — é o nosso controlo a funcionar. Fica
      // registado para ele saber porque é que a resposta não veio do modelo dele.
      await prisma.systemEvent
        .create({
          data: {
            severity: "INFO",
            source: "model-resolver",
            tenantId: agent!.tenantId,
            message: `Modelo "${model.name}" não está activo (${model.status}) — a chamada usou o motor da plataforma`,
            payload: { agentId, modelId: model.id, status: model.status },
          },
        })
        .catch(() => {});
    }
  }

  cache.set(agentId, { at: Date.now(), value: resolved });
  return resolved;
}

type ModelRow = {
  id: string;
  endpointUrl: string;
  protocol: string;
  modelName: string | null;
  authType: string;
  authSecret: string | null;
  authHeader: string | null;
  signingSecret: string | null;
  timeoutMs: number;
  maxReplyChars: number;
  updatedAt: Date;
};

/**
 * Devolve o adaptador vivo deste modelo, criando-o na primeira vez. Reutilizar
 * a instância é o que dá memória ao disjuntor entre chamadas.
 */
function getAdapter(model: ModelRow): LlmProvider {
  const key = `${model.id}:${model.updatedAt.getTime()}`;

  const existing = adapters.get(key);
  if (existing) return existing;

  // Uma versão anterior deste modelo deixa de servir assim que há uma nova.
  invalidateAdaptersFor(model.id);

  const adapter = buildAdapter(model);
  adapters.set(key, adapter);
  return adapter;
}

function invalidateAdaptersFor(modelId: string): void {
  for (const key of adapters.keys()) {
    if (key.startsWith(`${modelId}:`)) adapters.delete(key);
  }
}

function buildAdapter(model: ModelRow): LlmProvider {
  return new RemoteModelAdapter({
    endpointUrl: model.endpointUrl,
    protocol: model.protocol as "FALAI_TURN" | "OPENAI_CHAT" | "ANTHROPIC_MESSAGES",
    authType: model.authType as "BEARER" | "HEADER" | "NONE",
    timeoutMs: model.timeoutMs,
    maxReplyChars: model.maxReplyChars,
    ...(model.modelName !== null && { modelName: model.modelName }),
    ...(model.authSecret !== null && { authSecret: safeDecrypt(model.authSecret, model.id) }),
    // O campo do adaptador chama-se authHeaderName. Como isto é um spread
    // condicional, um nome errado não dá erro de tipos — passava em silêncio e
    // authType=HEADER saía sem cabeçalho de autenticação nenhum.
    ...(model.authHeader !== null && { authHeaderName: model.authHeader }),
    ...(model.signingSecret !== null && { signingSecret: safeDecrypt(model.signingSecret, model.id) }),
  });
}

/** Modelos cujo segredo já falhou a decifrar — para não registar por chamada. */
const decryptFailures = new Set<string>();

/**
 * Um segredo que não decifra (ENCRYPTION_KEY trocada, valor corrompido) não
 * deve rebentar o arranque de uma chamada. Devolve vazio — mas deixa rasto:
 * sem o evento, o sintoma visível era "o endpoint do cliente devolve 401" e
 * ninguém chegava à causa.
 */
function safeDecrypt(value: string, modelId: string): string {
  try {
    return decryptSecret(value);
  } catch {
    if (!decryptFailures.has(modelId)) {
      decryptFailures.add(modelId);
      void prisma.systemEvent
        .create({
          data: {
            severity: "ERROR",
            source: "model-resolver",
            message: `Não foi possível decifrar o segredo do modelo ${modelId} — verifica a ENCRYPTION_KEY`,
            payload: { modelId },
          },
        })
        .catch(() => {});
    }
    return "";
  }
}

/**
 * Constrói um adaptador a partir de um modelo guardado, sem passar por agente
 * nem exigir que esteja ACTIVE. É o que serve o botão "testar modelo" e o
 * simulador: o cliente tem de poder experimentar antes de submeter a aprovação.
 */
export async function buildAdapterForModel(modelId: string): Promise<LlmProvider | null> {
  const model = await prisma.tenantModel.findFirst({
    where: { id: modelId, deletedAt: null },
    select: {
      id: true, endpointUrl: true, protocol: true, modelName: true,
      authType: true, authSecret: true, authHeader: true, signingSecret: true,
      timeoutMs: true, maxReplyChars: true, updatedAt: true,
    },
  });
  if (!model) return null;
  // Instância descartável de propósito: um teste não deve herdar nem sujar o
  // disjuntor do adaptador que está a servir chamadas reais.
  return buildAdapter(model);
}
