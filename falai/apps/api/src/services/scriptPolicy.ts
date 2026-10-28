/**
 * Expressões que não podem ir num script de campanha FIXED_SCRIPT.
 *
 * O áudio é gerado na ElevenLabs, cuja política de uso proíbe coagir pessoas
 * em dificuldade financeira e o crédito predatório. Em 2026-10-28 o script de
 * cobrança "M1+" da FACIL CREDITO ameaçava com penhora, desconto no salário e
 * "processo registado em seu nome" em dezenas de milhares de chamadas; uma
 * suspensão da conta deixava todas as campanhas da plataforma sem voz.
 *
 * Compara-se sem acentos e sem maiúsculas, para "penhóra"/"PENHORA" também
 * serem apanhadas.
 */
const BLOCKED: Array<{ label: string; pattern: RegExp }> = [
  { label: "penhora", pattern: /\bpenhor(a|as|ar|ado|ados)\b/ },
  { label: "cobrança judicial", pattern: /\bcobranca(s)? (judicial|judiciais|coerciva)\b/ },
  { label: "ação judicial", pattern: /\b(acao|accao|processo|execucao) (judicial|em tribunal)\b/ },
  { label: "tribunal", pattern: /\btribuna(l|is)\b/ },
  { label: "desconto no salário", pattern: /\bdesconto (no|do|em|de) (seu )?(vencimento|salario|ordenado)\b/ },
  { label: "lista de devedores", pattern: /\blista (negra|de devedores|de incumpridores)\b/ },
  { label: "processo registado em seu nome", pattern: /\bprocesso registado em (seu|teu) nome\b/ },
];

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Devolve as expressões proibidas encontradas no texto (vazio = aceite). */
export function findBlockedScriptTerms(text: string): string[] {
  const t = normalize(text);
  return BLOCKED.filter((b) => b.pattern.test(t)).map((b) => b.label);
}
