/**
 * Auditoria de chamadas com IA.
 *
 * A IA audita sozinha e o auditor revê e submete:
 *   1. a gravação é transcrita uma vez (Deepgram, com quem fala) e fica em
 *      Call.transcript — cobra-se ao cliente por minuto da chamada
 *      (Tenant.qaAiPricePerMinCents, definido no backoffice);
 *   2. o Claude preenche a grelha de qualidade com justificação e a frase da
 *      chamada que a sustenta;
 *   3. fica uma QaEvaluation AI_DRAFT, sem avaliador, que o agente não vê. O
 *      auditor (ou supervisão) corrige e submete — aí passa a SUBMITTED.
 *
 * Arranca sozinha no fim da gravação (amostra Tenant.qaAiSamplePct) ou à mão
 * (POST /tenant/qa/ai/calls/:callId).
 */
import { readFile } from "node:fs/promises";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { ClaudeAdapter, DeepgramAdapter } from "@falai/providers";
import { reserveBalance } from "./billing.service.js";
import { recordingContentType, recordingFilePath } from "./callRecording.service.js";
import { ANSWERS, QaError, agentOf, applyAutoCriteria, cleanAnswers, scoreEvaluation, validAnswer, type Answer, type FormDefinition } from "./quality.service.js";

export const PROMPT_VERSION = "qa-audit/v2"; // v2: escala 1–5 e divergências com a ficha

const SYSTEM_PROMPT = `És auditor de qualidade de um call center angolano. Recebes a grelha de avaliação (critérios com id) e a transcrição de uma chamada entre um agente e um cliente.

Regras:
- Avalia CADA critério. Critérios "yesno": "YES" (conforme), "NO" (não conforme) ou "NA" (não se aplica). Critérios "scale": "1" (muito mau) a "5" (excelente), ou "NA".
- Baseia-te só no que está na transcrição. Se não há evidência para concluir, usa "NA" e diz porquê.
- A transcrição é automática e pode ter erros; não penalizes o agente por palavras mal transcritas.
- "reason": uma frase curta em português europeu a justificar.
- "quote": a frase da transcrição que sustenta a resposta (copiada tal como está), ou vazio se não houver.
- Os oradores vêm numerados (Orador 0, Orador 1…); deduz pelo contexto qual é o agente.
- "summary": 2–3 frases com os pontos fortes e o que o agente deve melhorar.
- Se vier a "Ficha preenchida pelo agente", compara-a com o que o cliente disse. Em "divergences" põe só os campos em que a transcrição mostra claramente outro valor (ex.: o cliente diz um NIF e a ficha tem outro); lista vazia se não houver.`;

const TOOL = {
  name: "audit_call",
  description: "Regista a avaliação de cada critério da grelha.",
  input_schema: {
    type: "object" as const,
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            answer: { type: "string", enum: [...ANSWERS] },
            reason: { type: "string" },
            quote: { type: "string" },
          },
          required: ["id", "answer", "reason"],
        },
      },
      summary: { type: "string" },
      divergences: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            formValue: { type: "string" },
            said: { type: "string" },
            quote: { type: "string" },
          },
          required: ["field", "formValue", "said"],
        },
      },
    },
    required: ["criteria", "summary", "divergences"],
  },
};

type Utterance = { speaker: number; start: number; end?: number; text: string };
export type CallTranscript = { source: "recording"; durationSecs: number; utterances: Utterance[] };
type AiOutput = {
  criteria?: { id?: unknown; answer?: unknown; reason?: unknown; quote?: unknown }[];
  summary?: unknown;
  divergences?: { field?: unknown; formValue?: unknown; said?: unknown; quote?: unknown }[];
};

/** Minutos cobrados: arredonda para cima, mínimo 1. Pura. */
export const billedMinutes = (secs: number) => Math.max(1, Math.ceil(secs / 60));

/** Respostas e achados a partir da saída da IA; critério que ela esqueceu fica NA. Pura. */
export function parseAiOutput(def: FormDefinition, raw: unknown) {
  const out = (raw ?? {}) as AiOutput;
  const byId = new Map((out.criteria ?? []).map((c) => [String(c.id), c]));
  const answers: Record<string, Answer> = {};
  const criteria: Record<string, { reason: string; quote: string }> = {};
  for (const c of def.sections.flatMap((s) => s.criteria)) {
    if (c.type === "auto_form") continue; // responde o sistema
    const r = byId.get(c.id);
    const a = validAnswer(c.type ?? "yesno", r?.answer) ? (r!.answer as Answer) : "NA";
    answers[c.id] = a;
    criteria[c.id] = {
      reason: r ? String(r.reason ?? "").slice(0, 500) : "A IA não avaliou este critério.",
      quote: r ? String(r.quote ?? "").slice(0, 500) : "",
    };
  }
  const str = (v: unknown) => String(v ?? "").slice(0, 300);
  const divergences = (out.divergences ?? []).slice(0, 30).map((d) => ({ field: str(d.field), formValue: str(d.formValue), said: str(d.said), quote: str(d.quote) }));
  return { answers, criteria, summary: String(out.summary ?? "").slice(0, 2000), divergences };
}

/**
 * Métricas da transcrição, sem IA. Pura.
 *   talk: segundos e % de fala por orador
 *   longestSilenceSecs: maior pausa entre duas frases seguidas
 *   interruptions: frases que começam antes de a do outro orador acabar (> 0,5 s)
 *   forbidden: palavras proibidas ditas, com o momento e quem disse
 * Sem o fim das frases (transcrições antigas) só há o forbidden.
 */
export function transcriptMetrics(t: CallTranscript, forbiddenWords: string[]) {
  const us = t.utterances;
  const timed = us.every((u) => typeof u.end === "number");
  const talk = new Map<number, number>();
  let longestSilenceSecs = 0;
  let interruptions = 0;
  if (timed) {
    for (const [i, u] of us.entries()) {
      talk.set(u.speaker, (talk.get(u.speaker) ?? 0) + Math.max(0, u.end! - u.start));
      const prev = us[i - 1];
      if (!prev) continue;
      longestSilenceSecs = Math.max(longestSilenceSecs, u.start - prev.end!);
      if (prev.speaker !== u.speaker && u.start < prev.end! - 0.5) interruptions += 1;
    }
  }
  const total = [...talk.values()].reduce((a, b) => a + b, 0);
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = forbiddenWords.map((w) => ({ w, re: new RegExp(`(^|[^a-z0-9])${norm(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`) }));
  const forbidden = us.flatMap((u) => words.filter(({ re }) => re.test(norm(u.text))).map(({ w }) => ({ word: w, start: u.start, speaker: u.speaker })));
  return {
    talk: timed ? [...talk.entries()].sort((a, b) => a[0] - b[0]).map(([speaker, secs]) => ({ speaker, secs: Math.round(secs), pct: total ? Math.round((secs / total) * 100) : 0 })) : null,
    longestSilenceSecs: timed ? Math.round(longestSilenceSecs * 10) / 10 : null,
    interruptions: timed ? interruptions : null,
    forbidden,
  };
}

/** Transcrição em texto para o prompt: "[mm:ss] Orador N: …". Pura. */
export function transcriptText(t: CallTranscript): string {
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return t.utterances.map((u) => `[${mmss(u.start)}] Orador ${u.speaker}: ${u.text}`).join("\n");
}

async function adapters(fastify: FastifyInstance) {
  // Import tardio: config.js valida o .env ao carregar e isto é importado pelo router das chamadas.
  const { config } = await import("../config.js");
  const p = fastify.providerConfig;
  return {
    stt: new DeepgramAdapter({ apiKey: p.deepgram.apiKey, model: "nova-3", language: "pt", stubMode: p.aiStubMode || !p.deepgram.apiKey }),
    llm: new ClaudeAdapter({ apiKey: p.anthropic.apiKey, model: config.AI_REPORT_MODEL, stubMode: p.aiStubMode || !p.anthropic.apiKey }),
  };
}

/**
 * Transcreve a gravação (se ainda não estiver) e cobra os minutos. O saldo é
 * reservado antes de chamar o Deepgram e devolvido se a transcrição falhar.
 */
async function ensureTranscript(fastify: FastifyInstance, tenantId: string, callId: string): Promise<CallTranscript> {
  const call = await prisma.call.findFirst({ where: { id: callId, tenantId }, select: { recordingUrl: true, transcript: true, durationSecs: true } });
  if (!call) throw new QaError(404, "Chamada não encontrada");
  const cached = call.transcript as CallTranscript | null;
  if (cached?.source === "recording") return cached;
  if (!call.recordingUrl) throw new QaError(400, "Esta chamada não tem gravação");
  const file = await recordingFilePath(call.recordingUrl);
  if (!file || file === "NO_DIR") throw new QaError(400, "Gravação indisponível");

  const { qaAiPricePerMinCents: price } = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { qaAiPricePerMinCents: true } });
  const minutes = billedMinutes(call.durationSecs);
  const amountCents = minutes * price;
  if (!(await reserveBalance(tenantId, amountCents))) throw new QaError(402, "Saldo insuficiente para a auditoria com IA");

  let transcript: CallTranscript;
  try {
    const audio = await readFile(file);
    const res = await (await adapters(fastify)).stt.transcribeFile(audio, recordingContentType(file));
    if (!res) throw new QaError(503, "Transcrição indisponível (IA em modo de teste)");
    if (!res.utterances.length) throw new QaError(422, "A gravação não tem fala que se transcreva");
    transcript = { source: "recording", ...res };
  } catch (err) {
    if (amountCents > 0) await prisma.tenant.update({ where: { id: tenantId }, data: { balanceCents: { increment: amountCents } } });
    throw err;
  }

  await prisma.call.update({ where: { id: callId }, data: { transcript } });
  if (amountCents > 0) {
    const { balanceCents } = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { balanceCents: true } });
    await prisma.walletTransaction.create({
      data: {
        tenantId,
        type: "QA_CHARGE",
        amountCents: -amountCents,
        balanceAfterCents: balanceCents,
        note: `Auditoria IA — ${minutes} min — chamada ${callId}`,
        reference: callId,
      },
    });
  }
  return transcript;
}

/** Audita uma chamada com a grelha indicada (ou a do tenant). Devolve o rascunho criado. */
export async function runAiAudit(fastify: FastifyInstance, tenantId: string, callId: string, formId?: string): Promise<{ id: string }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { qaAiFormId: true } });
  const id = formId ?? tenant.qaAiFormId;
  const form = id ? await prisma.qaForm.findFirst({ where: { id, tenantId, isActive: true } }) : null;
  if (!form) throw new QaError(400, "Escolha a grelha da auditoria com IA");
  if (await prisma.qaEvaluation.count({ where: { tenantId, callId } })) throw new QaError(409, "Esta chamada já tem avaliação");
  const agentId = await agentOf(tenantId, { callId });
  if (!agentId) throw new QaError(400, "Esta chamada não foi atendida por um agente com utilizador");

  const transcript = await ensureTranscript(fastify, tenantId, callId);
  const def = form.definition as FormDefinition;
  const grid = def.sections.map((s) => ({
    section: s.title,
    criteria: s.criteria.filter((c) => c.type !== "auto_form").map((c) => ({ id: c.id, label: c.label, type: c.type ?? "yesno", critical: c.critical })),
  }));
  const { formData } = await prisma.call.findUniqueOrThrow({ where: { id: callId }, select: { formData: true } });
  const ficha = formData ? `\n\nFicha preenchida pelo agente:\n${JSON.stringify((formData as { values?: unknown }).values ?? {})}` : "";
  const out = await (await adapters(fastify)).llm.structured({
    system: SYSTEM_PROMPT,
    user: `Grelha:\n${JSON.stringify(grid)}${ficha}\n\nTranscrição:\n${transcriptText(transcript)}`,
    tool: TOOL,
    maxTokens: 8192, // folga: o tokenizador do Sonnet 5 conta ~30 % mais
    timeoutMs: 120_000,
  });
  if (!out) throw new QaError(503, "IA em modo de teste — sem auditoria");

  const parsed = parseAiOutput(def, out.input);
  const answers = await applyAutoCriteria(tenantId, def, parsed.answers, callId);
  const { score, criticalFail } = scoreEvaluation(def, answers);
  return prisma.qaEvaluation.create({
    data: {
      tenantId,
      formId: form.id,
      formSnapshot: { name: form.name, ...def },
      callId,
      agentId,
      answers: cleanAnswers(def, answers),
      score,
      criticalFail,
      status: "AI_DRAFT",
      aiFindings: {
        summary: parsed.summary,
        criteria: parsed.criteria,
        divergences: parsed.divergences,
        model: out.model,
        prompt: PROMPT_VERSION,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
      },
    },
    select: { id: true },
  });
}

// ponytail: uma auditoria de cada vez, em memória — perde as pendentes se a API
// reiniciar. Passar a fila BullMQ se o volume justificar.
let chain: Promise<unknown> = Promise.resolve();

/** No fim da gravação: entra na amostra do tenant? Então audita, em fila, sem bloquear. */
export async function maybeAutoAudit(fastify: FastifyInstance, callId: string, log: FastifyBaseLogger): Promise<void> {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { tenantId: true, tenant: { select: { qaAiFormId: true, qaAiSamplePct: true } } },
  });
  const pct = call?.tenant.qaAiSamplePct ?? 0;
  if (!call?.tenant.qaAiFormId || pct <= 0 || Math.random() * 100 >= pct) return;
  chain = chain.then(() =>
    runAiAudit(fastify, call.tenantId, callId).then(
      (ev) => log.info({ callId, evaluationId: ev.id }, "qa_ai.drafted"),
      (err) => log[err instanceof QaError ? "info" : "error"]({ err, callId }, "qa_ai.skipped")
    )
  );
}
