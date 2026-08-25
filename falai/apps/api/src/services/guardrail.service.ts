/**
 * Guardrails da plataforma — validação da RESPOSTA, não do prompt.
 *
 * Enquanto o agente era nosso, o guardrail era texto anexado ao system prompt
 * (services/agentCompiler.ts, secção "Regras gerais"). No produto API_BYOM isso
 * deixa de servir: o prompt é do cliente e o modelo é do cliente, portanto nada
 * do que escrevemos no prompt é garantido. A única barreira que ele não pode
 * contornar é a que corre do NOSSO lado, depois de o modelo responder e antes
 * de a resposta virar voz.
 *
 * Corre para os dois motores — o dele e o nosso. Não há caminho que a evite.
 * Ver TurnProcessor.processTurn, entre o passo 2 (LLM) e o 3 (TTS).
 */

import { prisma } from "@falai/db";
import { getSetting } from "./settings.service.js";

/**
 * Violações ACUMULADAS antes de o modelo se bloquear sozinho. O contador é
 * cumulativo de propósito — um modelo que viola uma vez em cada dez turnos é
 * tão inaceitável como um que viola dez seguidas — e só é reposto a zero
 * quando um humano volta a aprovar o modelo (routes/admin/models-moderation).
 */
export const GUARDRAIL_AUTO_BLOCK = 20;

/** Tecto absoluto de caracteres numa resposta falada, seja qual for o modelo. */
const HARD_REPLY_LIMIT = 1500;

/** Chave em SystemSetting com a lista global de frases proibidas (uma por linha). */
export const BANNED_PHRASES_SETTING = "GUARDRAIL_BANNED_PHRASES";

/** O que se diz quando a resposta do modelo é recusada. Nunca silêncio. */
export const FALLBACK_REPLY = "Peço desculpa, não consegui processar isso. Pode repetir, por favor?";

export type GuardrailFlag =
  | "empty_reply"
  | "reply_too_long"
  | "banned_phrase"
  | "invalid_action"
  | "escalation_not_allowed";

export interface GuardrailContext {
  tenantId: string;
  /** Modelo que produziu a resposta. Null = motor da plataforma. */
  modelId?: string | null;
  callId: string;
  /** Números para onde este tenant pode transferir uma chamada. */
  allowedEscalationNumbers: string[];
  maxReplyChars?: number;
}

export interface GuardrailInput {
  reply: string;
  action: { type: string; to?: string; data?: unknown };
}

export interface GuardrailResult {
  /** A resposta a usar. Igual à entrada quando passou limpa. */
  reply: string;
  action: { type: string; to?: string; data?: unknown };
  flags: GuardrailFlag[];
  /** True se alguma regra disparou — quem chama grava e conta. */
  violated: boolean;
}

const VALID_ACTIONS = new Set(["continue", "end_call", "escalate", "capture"]);

/** Só dígitos, para comparar números escritos de formas diferentes. */
function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Um número nacional angolano tem 9 dígitos. Abaixo disto estamos a olhar para
 * uma extensão interna ("200", "1001"), que só pode casar por igualdade exacta.
 */
const NATIONAL_DIGITS = 9;

/**
 * O destino de um escalate é permitido?
 *
 * A comparação por sufixo é necessária — o mesmo número aparece como
 * "+244923000000", "244923000000" e "923000000" — mas tem de ser apertada.
 * Comparar sufixos de qualquer comprimento era um buraco grave: com a extensão
 * "200" na lista, `"244923000200".endsWith("200")` dava verdade e o modelo
 * conseguia transferir a chamada para um número à escolha dele. Pior ainda ao
 * contrário: `to: "2"` casava com tudo o que acabasse em 2.
 *
 * Regra: só se comparam sufixos quando AMBOS os lados têm pelo menos 9 dígitos.
 * Extensões e números curtos exigem igualdade exacta.
 */
function escalationAllowed(target: string, allowed: string[]): boolean {
  if (target === "") return false;

  return allowed.some((n) => {
    if (n === "") return false;
    if (n === target) return true;
    if (n.length < NATIONAL_DIGITS || target.length < NATIONAL_DIGITS) return false;
    // Ambos são números completos: um pode trazer indicativo e o outro não.
    return n.endsWith(target) || target.endsWith(n);
  });
}

/**
 * Lista global de frases proibidas, definida pelo operador no backoffice.
 * Cache de 60s: isto corre a cada turno de cada chamada e não vale uma ida à
 * base de dados de cada vez; 60s é tempo suficiente para uma alteração entrar.
 */
let bannedCache: { at: number; value: string[] } = { at: 0, value: [] };

export async function getBannedPhrases(): Promise<string[]> {
  if (Date.now() - bannedCache.at < 60_000) return bannedCache.value;

  const raw = (await getSetting(BANNED_PHRASES_SETTING)) ?? "";
  const value = raw
    .split("\n")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3); // menos de 3 caracteres daria falsos positivos em tudo

  bannedCache = { at: Date.now(), value };
  return value;
}

/** Esquece a cache. Chamado quando o operador grava a lista no backoffice. */
export function invalidateBannedPhrasesCache(): void {
  bannedCache = { at: 0, value: [] };
}

/** Corta no limite sem partir uma palavra a meio. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Aplica os guardrails a uma resposta. Nunca lança: devolve sempre algo que se
 * pode falar. Uma chamada ao vivo não pode ficar em silêncio por causa disto.
 */
export async function applyGuardrails(
  input: GuardrailInput,
  context: GuardrailContext
): Promise<GuardrailResult> {
  const flags: GuardrailFlag[] = [];
  let reply = typeof input.reply === "string" ? input.reply.trim() : "";
  let action = { ...input.action };

  // 1. Resposta vazia — o modelo não disse nada de útil.
  if (reply === "") {
    flags.push("empty_reply");
    reply = FALLBACK_REPLY;
  }

  // 2. Comprimento. O limite do modelo pode ser mais apertado que o nosso, mas
  //    nunca mais largo: numa chamada, um monólogo de 3000 caracteres é um
  //    minuto de voz que o cliente final não vai ouvir até ao fim.
  const limit = Math.min(context.maxReplyChars ?? HARD_REPLY_LIMIT, HARD_REPLY_LIMIT);
  if (reply.length > limit) {
    flags.push("reply_too_long");
    reply = truncate(reply, limit);
  }

  // 3. Frases proibidas pela plataforma. Substitui-se a resposta inteira: não
  //    se tenta "limpar" o texto, porque uma frase proibida costuma vir num
  //    contexto que também não queremos falar.
  const banned = await getBannedPhrases();
  if (banned.length > 0) {
    const lower = reply.toLowerCase();
    if (banned.some((phrase) => lower.includes(phrase))) {
      flags.push("banned_phrase");
      reply = FALLBACK_REPLY;
    }
  }

  // 4. Acção desconhecida — trata-se como "continuar", que é o único
  //    comportamento seguro (não desliga nem transfere ninguém).
  if (!VALID_ACTIONS.has(action.type)) {
    flags.push("invalid_action");
    action = { type: "continue" };
  }

  // 5. Escalar só para números do próprio tenant. Sem isto, um modelo
  //    comprometido podia desviar chamadas dos clientes finais para um número
  //    qualquer — é a violação mais cara desta lista.
  if (action.type === "escalate") {
    const target = digits(action.to ?? "");
    const allowed = context.allowedEscalationNumbers.map(digits).filter(Boolean);
    if (!escalationAllowed(target, allowed)) {
      flags.push("escalation_not_allowed");
      action = { type: "continue" };
    }
  }

  return { reply, action, flags, violated: flags.length > 0 };
}

/**
 * Regista uma violação e bloqueia o modelo se já forem demasiadas.
 * Fire-and-forget do lado de quem chama: não deve atrasar a chamada.
 */
export async function recordViolation(params: {
  tenantId: string;
  modelId?: string | null;
  callId: string;
  flags: GuardrailFlag[];
  originalReply: string;
}): Promise<void> {
  await prisma.systemEvent.create({
    data: {
      severity: "WARNING",
      source: "guardrail",
      tenantId: params.tenantId,
      message: `Resposta recusada pelos guardrails (${params.flags.join(", ")})`,
      payload: {
        callId: params.callId,
        modelId: params.modelId ?? null,
        flags: params.flags,
        // Guardamos um excerto, não a resposta inteira: chega para investigar
        // sem encher a tabela de eventos com transcrições.
        excerpt: params.originalReply.slice(0, 300),
      },
    },
  });

  if (!params.modelId) return; // motor da plataforma: não há modelo do cliente a penalizar

  const model = await prisma.tenantModel.update({
    where: { id: params.modelId },
    data: { violations: { increment: 1 } },
    select: { id: true, name: true, violations: true, status: true },
  });

  if (model.violations >= GUARDRAIL_AUTO_BLOCK && model.status !== "BLOCKED") {
    await prisma.tenantModel.update({
      where: { id: model.id },
      data: { status: "BLOCKED", lastError: `Bloqueado automaticamente após ${model.violations} violações` },
    });

    await prisma.systemEvent.create({
      data: {
        severity: "ERROR",
        source: "guardrail",
        tenantId: params.tenantId,
        message: `Modelo "${model.name}" BLOQUEADO automaticamente após ${model.violations} violações`,
        payload: { modelId: model.id, violations: model.violations },
      },
    });
  }
}
