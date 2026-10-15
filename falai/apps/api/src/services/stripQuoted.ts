/**
 * Corta o texto citado de uma resposta. Sem isto o custo por mensagem explode
 * e a IA responde ao histórico dela própria.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const markers = [
    /^On .+wrote:\s*$/i,
    /^Em .+escreveu:\s*$/i,
    /^Le .+a écrit\s*:\s*$/i,
    /^-{2,}\s*(Original Message|Mensagem original|Forwarded message|Mensagem encaminhada)/i,
    /^_{5,}\s*$/,
    /^(From|De):\s.+/i,
  ];
  const out: string[] = [];
  for (const line of lines) {
    if (markers.some((m) => m.test(line.trim()))) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  // Assinatura padrão "-- "
  const sig = out.findIndex((l) => l === "-- ");
  return (sig >= 0 ? out.slice(0, sig) : out).join("\n").trim();
}
