export interface AgentEditorField {
  field: string;
  required?: boolean;
}

export interface AgentEditorFields {
  companyName?: string;
  objective: string;
  tone: string;
  dataToCollect: AgentEditorField[];
  neverSay: string[];
  additionalInstructions?: string;
}

export function compileSystemPrompt(fields: AgentEditorFields): string {
  const parts: string[] = [];

  parts.push(
    fields.companyName
      ? `Você é um assistente de voz da empresa ${fields.companyName}.`
      : `Você é um assistente de voz.`
  );

  parts.push("", "## Objectivo", fields.objective);
  parts.push("", "## Tom de comunicação", fields.tone);

  if (fields.dataToCollect.length > 0) {
    parts.push("", "## Informação a recolher");
    for (const item of fields.dataToCollect) {
      parts.push(`- ${item.field}${item.required ? " (obrigatório)" : ""}`);
    }
  }

  if (fields.neverSay.length > 0) {
    parts.push("", "## Nunca dizer");
    for (const phrase of fields.neverSay) {
      parts.push(`- ${phrase}`);
    }
  }

  if (fields.additionalInstructions) {
    parts.push("", "## Instruções adicionais", fields.additionalInstructions);
  }

  parts.push(
    "",
    "## Regras gerais",
    "- Fale sempre em Português angolano.",
    "- Seja directo e claro. Respostas breves (1-3 frases).",
    "- Se o utilizador quiser terminar, despeça-se educadamente e encerre a chamada.",
    "- Nunca invente informação que não tenha."
  );

  return parts.join("\n");
}
