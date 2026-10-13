/**
 * TV da sala de supervisão (wallboard). A rota está em routes/tenant/supervision.ts
 * (GET /tenant/supervision/wallboard); aqui ficam as contas puras.
 *
 * Regra da TV: nunca mostra números de telefone dos clientes — só o nome do
 * contacto, se existir (a sala pode ter visitas).
 */

export interface RankLeg {
  extensionId: string | null;
  answeredAt: Date | null;
  endedAt: Date | null;
}

export interface RankRow {
  extensionId: string;
  name: string;
  answered: number;
  tmaSecs: number | null;
  csatAvg: number | null;
}

/**
 * Ranking do dia: mais atendidas primeiro; empate → menor TMA; depois melhor
 * satisfação. Só entra quem atendeu alguma. Pura.
 */
export function rankAgents(
  legs: RankLeg[],
  names: Map<string, string>,
  csatByExt: Map<string, number[]>,
  limit = 10
): RankRow[] {
  const by = new Map<string, number[]>();
  for (const l of legs) {
    if (!l.extensionId || !l.answeredAt) continue;
    const list = by.get(l.extensionId) ?? [];
    if (l.endedAt) list.push((l.endedAt.getTime() - l.answeredAt.getTime()) / 1000);
    else list.push(NaN); // em curso: conta como atendida, não entra no TMA
    by.set(l.extensionId, list);
  }
  const avg = (v: number[]) => {
    const ok = v.filter((x) => Number.isFinite(x));
    return ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
  };
  const rows: RankRow[] = [...by].map(([extensionId, durations]) => {
    const scores = csatByExt.get(extensionId) ?? [];
    return {
      extensionId,
      name: names.get(extensionId) ?? "—",
      answered: durations.length,
      tmaSecs: avg(durations),
      csatAvg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    };
  });
  const big = Number.MAX_SAFE_INTEGER;
  return rows
    .sort((a, b) => b.answered - a.answered || (a.tmaSecs ?? big) - (b.tmaSecs ?? big) || (b.csatAvg ?? 0) - (a.csatAvg ?? 0))
    .slice(0, limit);
}
