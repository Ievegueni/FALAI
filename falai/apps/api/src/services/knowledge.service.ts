import { prisma } from "@falai/db";

/**
 * Base de conhecimento (centro de atendimento, fase 10) — ver
 * docs/PLANO-CENTRO-ATENDIMENTO.md. Artigos que o agente consulta no CRM e que
 * a IA dos canais de texto usa como contexto quando são relevantes.
 *
 * Relevância por palavras em comum (título vale o triplo), sem embeddings.
 * ponytail: chega para dezenas/centenas de artigos; passar a pesquisa por
 * texto completo / vectores se um cliente tiver milhares.
 */

/** Minúsculas e sem acentos (os acentos combinantes U+0300–U+036F saem depois do NFD). */
const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Palavras que não dizem nada sobre o assunto (comparadas já sem acentos).
const STOP = new Set(
  fold(
    "a o as os um uma uns umas de do da dos das em no na nos nas por para com sem que e ou se ao aos à às é são foi ser ter tem como mais mas não sim já eu tu ele ela nós vós eles elas meu minha seu sua isto isso aquilo este esta esse essa qual quais quando onde porque pois bom boa dia tarde noite olá obrigado obrigada favor preciso quero the and for with you"
  ).split(" ")
);

/** Palavras com conteúdo, sem acentos nem maiúsculas. Pura. */
export function keywords(text: string): string[] {
  return [...new Set(fold(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

export interface KbCandidate { id: string; title: string; body: string }

/** Os `n` artigos mais relevantes para a pergunta (0 pontos = fora). Pura. */
export function pickArticles<T extends KbCandidate>(question: string, articles: T[], n = 3): T[] {
  const q = keywords(question);
  if (q.length === 0) return [];
  return articles
    .map((a) => {
      const title = new Set(keywords(a.title));
      const body = new Set(keywords(a.body));
      const score = q.reduce((s, w) => s + (title.has(w) ? 3 : 0) + (body.has(w) ? 1 : 0), 0);
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, n)
    .map((x) => x.a);
}

const MAX_AI_ARTICLES = 300;
const MAX_CHARS_PER_ARTICLE = 1500;

/** Bloco para o prompt da IA com os artigos relevantes ("" se não houver). */
export async function knowledgeContext(tenantId: string, question: string): Promise<string> {
  const articles = await prisma.kbArticle.findMany({
    where: { tenantId, isPublished: true, aiEnabled: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_AI_ARTICLES,
    select: { id: true, title: true, body: true },
  });
  const picked = pickArticles(question, articles);
  if (picked.length === 0) return "";
  return [
    "",
    "## Base de conhecimento da empresa",
    "Use estes artigos para responder quando forem relevantes. Não invente o que não estiver aqui.",
    ...picked.map((a) => `### ${a.title}\n${a.body.slice(0, MAX_CHARS_PER_ARTICLE)}`),
  ].join("\n");
}
