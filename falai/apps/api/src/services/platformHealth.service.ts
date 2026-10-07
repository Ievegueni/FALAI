import type { FastifyInstance } from "fastify";
import { prisma } from "@falai/db";
import { trunkEndpointId } from "@falai/providers";
import { getAsteriskStatus } from "./asteriskStatus.service.js";
import { emitWebhookAsync } from "./webhookEmitter.service.js";

/**
 * Vigilância da plataforma (centro de atendimento, fase 11 — continuidade).
 * Ver docs/CONTINUIDADE-DO-SERVICO.md.
 *
 * A cada minuto: base de dados, Redis, motor de telefonia, registo SIP na
 * operadora e os peerings de cada cliente. Um componente só passa a "em baixo"
 * à 2.ª falha seguida (uma falha isolada não alarma) e volta logo à 1.ª
 * verificação boa. Cada mudança fica em SystemEvent (backoffice → Saúde), vai
 * por SSE para o CRM e por webhook `platform.status` para o sistema do cliente.
 *
 * Isto não avisa quando a própria API cai — para isso há o GET /status, que um
 * monitor externo deve vigiar.
 */

const CHECK_MS = 60_000;
const FAILS_TO_DOWN = 2;

export type ComponentKey = "database" | "redis" | "telephony" | "sipTrunk" | `peer:${string}`;
export interface ComponentState { up: boolean; fails: number; since: Date; detail: string | null; tenantId: string | null }
export interface Check { key: ComponentKey; ok: boolean; detail: string | null; tenantId: string | null }
export interface Transition { key: ComponentKey; up: boolean; detail: string | null; tenantId: string | null }

/** Aplica uma volta de verificações ao estado e devolve as mudanças. Pura. */
export function applyChecks(state: Map<ComponentKey, ComponentState>, checks: Check[], now: Date): Transition[] {
  const out: Transition[] = [];
  for (const c of checks) {
    const s = state.get(c.key) ?? { up: true, fails: 0, since: now, detail: null, tenantId: c.tenantId };
    if (c.ok) {
      if (!s.up) out.push({ key: c.key, up: true, detail: null, tenantId: c.tenantId });
      state.set(c.key, { up: true, fails: 0, since: s.up ? s.since : now, detail: null, tenantId: c.tenantId });
      continue;
    }
    const fails = s.fails + 1;
    const goesDown = s.up && fails >= FAILS_TO_DOWN;
    if (goesDown) out.push({ key: c.key, up: false, detail: c.detail, tenantId: c.tenantId });
    state.set(c.key, { up: s.up && !goesDown, fails, since: goesDown ? now : s.since, detail: c.detail, tenantId: c.tenantId });
  }
  return out;
}

const state = new Map<ComponentKey, ComponentState>();

/** Estado actual, para o CRM (do cliente: os gerais e os peerings dele) e para o /status. */
export function platformStatus(tenantId?: string) {
  const components = [...state.entries()]
    .filter(([, s]) => s.tenantId === null || s.tenantId === tenantId)
    .map(([key, s]) => ({ key, up: s.up, since: s.since.toISOString() }));
  return { ok: components.every((c) => c.up), components };
}

async function runChecks(fastify: FastifyInstance): Promise<Check[]> {
  const checks: Check[] = [];
  const attempt = async (key: ComponentKey, fn: () => Promise<unknown>) => {
    try {
      await fn();
      checks.push({ key, ok: true, detail: null, tenantId: null });
    } catch (err) {
      checks.push({ key, ok: false, detail: (err as Error).message?.slice(0, 200) ?? "erro", tenantId: null });
    }
  };
  await attempt("database", () => prisma.$queryRaw`SELECT 1`);
  await attempt("redis", () => fastify.redis.ping());
  const engine = await fastify.telephony.healthCheck().catch((err: Error) => ({ ok: false, details: err.message }));
  checks.push({ key: "telephony", ok: engine.ok, detail: engine.ok ? null : String(engine.details ?? "motor inacessível"), tenantId: null });

  // Registo na operadora e peerings: só se o motor responde (senão é a mesma falha).
  if (engine.ok) {
    const peers = await prisma.trunk.findMany({ where: { type: "PEER", enabled: true }, select: { name: true, host: true, tenantId: true } }).catch(() => []);
    const st = await getAsteriskStatus(peers.map((p) => ({ endpoint: trunkEndpointId(p.name), trunkName: p.name, tenantId: p.tenantId, host: p.host })));
    if (st.engineReachable && st.trunks.length) {
      const down = st.trunks.filter((t) => t.status === "NOT_REGISTERED");
      checks.push({ key: "sipTrunk", ok: down.length === 0, detail: down.length ? `Sem registo: ${down.map((t) => t.name).join(", ")}` : null, tenantId: null });
    }
    for (const p of st.peers) {
      if (p.status === "UNKNOWN") continue;
      checks.push({ key: `peer:${p.trunkName}`, ok: p.status === "REACHABLE", detail: p.status === "REACHABLE" ? null : `Peering ${p.trunkName} (${p.host}) sem resposta`, tenantId: p.tenantId });
    }
  }
  return checks;
}

async function announce(fastify: FastifyInstance, t: Transition) {
  const message = t.up ? `Recuperado: ${t.key}` : `Indisponível: ${t.key}${t.detail ? ` — ${t.detail}` : ""}`;
  await prisma.systemEvent
    .create({ data: { severity: t.up ? "info" : "critical", source: "platform-health", tenantId: t.tenantId, message, payload: { key: t.key, up: t.up, detail: t.detail } } })
    .catch(() => {}); // sem BD não há registo — o /status e o monitor externo cobrem
  fastify.log[t.up ? "info" : "error"]({ key: t.key, detail: t.detail, tenantId: t.tenantId }, "platform_health.transition");
  // Clientes afectados: um peering é só do dono; o resto é de todos.
  const tenants = t.tenantId
    ? [t.tenantId]
    : (await prisma.tenant.findMany({ where: { deletedAt: null, status: { in: ["ACTIVE", "TRIAL"] } }, select: { id: true } }).catch(() => [])).map((x) => x.id);
  for (const tenantId of tenants) {
    fastify.incomingCalls.broadcast(tenantId, "platform.status", { key: t.key, up: t.up });
    emitWebhookAsync({ tenantId, event: "platform.status", payload: { component: t.key, up: t.up, at: new Date().toISOString() } });
  }
}

export function startPlatformHealth(fastify: FastifyInstance): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const t of applyChecks(state, await runChecks(fastify), new Date())) await announce(fastify, t);
    } catch (err) {
      fastify.log.warn({ err }, "platform_health.check_failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), CHECK_MS);
  return () => clearInterval(timer);
}
