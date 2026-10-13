import { z } from "zod";
import { prisma } from "@falai/db";

/**
 * Metas de serviço do cliente (Tenant.serviceTargets) — usadas pelos alertas
 * (alerts.service.ts) e pelos relatórios (attendanceReport.service.ts). Módulo
 * à parte para os dois não se importarem um ao outro.
 *
 *   slaThresholdSecs  atendida em menos de X s conta para o SLA
 *   shortAbandonSecs  quem desliga antes de X s não conta para o SLA nem para
 *                     o abandono (engano, desistência imediata) — 0 = conta tudo
 *   groups            meta própria de um grupo: { [groupId]: { slaThresholdSecs?, slaTargetPct? } }
 */

export const DEFAULT_SLA_SECS = 21;
export const DEFAULT_SHORT_ABANDON_SECS = 5;

const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable().default(null);

export const groupTargetSchema = z.object({
  slaThresholdSecs: nullable(z.number().int().min(5).max(600)),
  slaTargetPct: nullable(z.number().min(1).max(100)),
});

export const targetsSchema = z.object({
  slaThresholdSecs: z.number().int().min(5).max(600).default(DEFAULT_SLA_SECS),
  slaTargetPct: nullable(z.number().min(1).max(100)),
  shortAbandonSecs: z.number().int().min(0).max(60).default(DEFAULT_SHORT_ABANDON_SECS),
  groups: z.record(z.string(), groupTargetSchema).default({}),
  maxWaitSecs: nullable(z.number().int().min(10).max(3600)),
  maxHandleSecs: nullable(z.number().int().min(30).max(14_400)),
  minAvailableAgents: nullable(z.number().int().min(1).max(100)),
  maxAbandonPct: nullable(z.number().min(0).max(100)),
  maxTmaSecs: nullable(z.number().int().min(10).max(14_400)),
});
export type ServiceTargets = z.infer<typeof targetsSchema>;

/** Metas guardadas (ou as por omissão, sem alertas, se nada ou lixo). */
export function parseTargets(raw: unknown): ServiceTargets {
  const r = targetsSchema.safeParse(raw ?? {});
  return r.success ? r.data : targetsSchema.parse({});
}

/** Regra do SLA de voz: limiar geral, limiar por grupo e desistências curtas. */
export interface SlaRule {
  secs: number;
  shortAbandonSecs: number;
  byGroup: Record<string, number>;
}

export const DEFAULT_SLA_RULE: SlaRule = { secs: DEFAULT_SLA_SECS, shortAbandonSecs: DEFAULT_SHORT_ABANDON_SECS, byGroup: {} };

export function slaRuleOf(t: ServiceTargets): SlaRule {
  const byGroup: Record<string, number> = {};
  for (const [gid, g] of Object.entries(t.groups)) if (g.slaThresholdSecs !== null) byGroup[gid] = g.slaThresholdSecs;
  return { secs: t.slaThresholdSecs, shortAbandonSecs: t.shortAbandonSecs, byGroup };
}

/** Limiar do SLA de uma chamada (o do grupo dela, se tiver). */
export const slaSecsFor = (rule: SlaRule, groupId: string | null) => (groupId !== null ? rule.byGroup[groupId] : undefined) ?? rule.secs;

/** Meta do SLA (%) de um grupo, ou a geral. */
export const slaTargetFor = (t: ServiceTargets, groupId: string | null) =>
  (groupId !== null ? t.groups[groupId]?.slaTargetPct : null) ?? t.slaTargetPct;

export async function tenantTargets(tenantId: string): Promise<ServiceTargets> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { serviceTargets: true } });
  return parseTargets(t?.serviceTargets);
}
