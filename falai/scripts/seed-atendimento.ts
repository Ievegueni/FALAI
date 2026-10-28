/**
 * seed-atendimento.ts — dados mock do centro de atendimento no tenant "Demo Company"
 * para apresentar: relatórios de tempo/estados dos agentes, pausas, callbacks,
 * fila, supervisão e TV da sala (/wallboard).
 *
 * Idempotente: apaga o que criou antes (chamadas "demo-*", pausas, sessões,
 * turnos e callbacks do tenant) e volta a criar, com as horas relativas a agora.
 * Os estados "em chamada" e "na fila" só aparecem com a API em DEMO_LIVE=1
 * (ver apps/api/src/services/demoLive.ts).
 *
 * Uso (na pasta falai): npx tsx --env-file=.env scripts/seed-atendimento.ts
 * Contas (password Demo1234!): sala@demo.com (TV), ana@ / bruno@ / carla@ /
 * delcio@ / edna@demo.com (agentes). As que já existem mantêm a password.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const db = new PrismaClient();
const T = 'tenant_demo';
const PASSWORD = 'Demo1234!';
const DID = '222000111';

const rand = (a: number, b: number) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = <X>(arr: X[]): X => arr[Math.floor(Math.random() * arr.length)]!;
const sec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
const now = new Date();
const ago = (s: number) => sec(now, -s);

const AGENTS = [
  { number: '1000', email: 'ana@demo.com' },
  { number: '1001', email: 'bruno@demo.com' },
  { number: '1002', email: 'carla@demo.com' },
  { number: '1003', email: 'delcio@demo.com' },
  { number: '1004', email: 'edna@demo.com' },
];

async function main() {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: T }, select: { serviceTargets: true } });
  const exts = await db.extension.findMany({ where: { tenantId: T, number: { in: AGENTS.map((a) => a.number) } }, include: { groups: true } });
  const groups = await db.extensionGroup.findMany({ where: { tenantId: T, name: { in: ['VENDAS', 'SUPORTE', 'FACTURACAO'] } } });
  const G = Object.fromEntries(groups.map((g) => [g.name, g.id])) as Record<'VENDAS' | 'SUPORTE' | 'FACTURACAO', string>;
  const contacts = await db.contact.findMany({ where: { tenantId: T, name: { not: null }, phone: { not: null } }, take: 60, select: { id: true, name: true, phone: true } });
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

  // ── Limpeza do que este script criou antes ─────────────────────────────────
  const oldCalls = (await db.call.findMany({ where: { tenantId: T, yeastarCallId: { startsWith: 'demo-' } }, select: { id: true } })).map((c) => c.id);
  await db.csatResponse.deleteMany({ where: { tenantId: T, callId: { in: oldCalls } } });
  await db.callLeg.deleteMany({ where: { callId: { in: oldCalls } } });
  await db.call.deleteMany({ where: { id: { in: oldCalls } } });
  await db.queueCallback.deleteMany({ where: { tenantId: T } });
  await db.agentPause.deleteMany({ where: { tenantId: T } });
  await db.extension.updateMany({ where: { tenantId: T }, data: { pausedAt: null } });

  // ── Agentes (uma conta por extensão) e conta da sala ────────────────────────
  const users: { id: string; name: string; extId: string; groupIds: string[] }[] = [];
  for (const a of AGENTS) {
    const ext = exts.find((e) => e.number === a.number)!;
    const name = ext.displayName ?? a.number;
    // Se a extensão já tem dono, usa-o (extensionId é único).
    const owner = await db.tenantUser.findFirst({ where: { extensionId: ext.id } });
    const u = owner ?? (await db.tenantUser.upsert({
      where: { email: a.email },
      update: { extensionId: ext.id },
      create: { tenantId: T, name, email: a.email, passwordHash: hash, role: 'MEMBER', extensionId: ext.id },
    }));
    users.push({ id: u.id, name, extId: ext.id, groupIds: ext.groups.map((g) => g.groupId) });
  }
  const userIds = users.map((u) => u.id);
  await db.agentSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.shift.deleteMany({ where: { userId: { in: userIds } } });

  const sala = await db.tenantUser.upsert({
    where: { email: 'sala@demo.com' },
    update: {},
    create: { tenantId: T, name: 'TV Sala de Atendimento', email: 'sala@demo.com', passwordHash: hash, role: 'SUPERVISOR' },
  });
  const sofia = await db.tenantUser.findFirst({ where: { tenantId: T, role: 'SUPERVISOR', email: 'supervisor@demo.com' } });
  for (const sup of [sala, sofia].filter(Boolean)) {
    for (const gid of Object.values(G)) {
      await db.supervisorGroup.upsert({ where: { tenantUserId_groupId: { tenantUserId: sup!.id, groupId: gid } }, update: {}, create: { tenantUserId: sup!.id, groupId: gid } });
    }
  }

  // ── Definições: fila com callback e metas ──────────────────────────────────
  const targets = (tenant.serviceTargets ?? {}) as Record<string, unknown>;
  await db.tenant.update({
    where: { id: T },
    data: {
      queueConfig: {
        maxWaitSecs: 300,
        callback: true,
        callbackAfterSecs: 45,
        offer: 'Todos os nossos agentes estão ocupados. Para lhe ligarmos de volta assim que houver um agente livre, prima 1. Para continuar à espera, mantenha-se em linha.',
        thanks: 'Obrigado. Vamos ligar-lhe assim que houver um agente livre.',
      },
      serviceTargets: { ...targets, slaThresholdSecs: 20, slaTargetPct: 80, maxWaitSecs: 60, maxAbandonPct: 8 },
    },
  });

  // ── Motivos de pausa (PAUSE BREAK e REMUP são motivos, como pedido) ────────
  const reasons: Record<string, string> = {};
  for (const [i, label] of ['Almoço', 'Pause Break', 'REMUP', 'Formação'].entries()) {
    const r = await db.pauseReason.upsert({ where: { tenantId_label: { tenantId: T, label } }, update: { isActive: true }, create: { tenantId: T, label, sortOrder: i } });
    reasons[label] = r.id;
  }

  // ── Tipificação em vários níveis (por baixo de "Reclamação › Facturação") ──
  const cat = async (id: string, parentId: string, name: string, sortOrder = 0) =>
    db.callCategory.upsert({ where: { id }, update: { parentId, name, isActive: true }, create: { id, tenantId: T, parentId, name, sortOrder } });
  if (await db.callCategory.count({ where: { id: 'mock_sub_0_0', tenantId: T } })) {
    await cat('demo_cat_cobranca', 'mock_sub_0_0', 'Cobrança indevida', 0);
    await cat('demo_cat_fatura', 'mock_sub_0_0', 'Fatura não recebida', 1);
    await cat('demo_cat_duplicado', 'demo_cat_cobranca', 'Valor em duplicado', 0);
    await cat('demo_cat_servico', 'demo_cat_cobranca', 'Serviço não contratado', 1);
  }
  // Últimos níveis para tipificar as chamadas demo: [categoria de topo, último nível].
  const allCats = await db.callCategory.findMany({ where: { tenantId: T, isActive: true }, select: { id: true, parentId: true } });
  const parentOf = new Map(allCats.map((c) => [c.id, c.parentId]));
  const topOf = (id: string) => { let cur = id; while (parentOf.get(cur)) cur = parentOf.get(cur)!; return cur; };
  const leaves: [string, string][] = allCats
    .filter((c) => c.parentId !== null && !allCats.some((x) => x.parentId === c.id))
    .map((c) => [topOf(c.id), c.id]);

  // ── Turnos (seg–sex 08:00–17:00) ────────────────────────────────────────────
  await db.shift.createMany({
    data: users.flatMap((u) => [1, 2, 3, 4, 5].map((weekday) => ({ tenantId: T, userId: u.id, weekday, startMin: 8 * 60, endMin: 17 * 60 }))),
  });

  // ── Sessões e pausas: 6 dias passados (08:00–17:00) + hoje (últimas 8 h) ───
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const todayFrom = new Date(Math.max(dayStart.getTime(), ago(8 * 3600).getTime()));
  for (const u of users) {
    for (let d = 6; d >= 1; d--) {
      const day = new Date(dayStart);
      day.setDate(day.getDate() - d);
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      const at = (h: number, m: number) => { const x = new Date(day); x.setHours(h, m + rand(-5, 5), rand(0, 59)); return x; };
      await db.agentSession.create({ data: { tenantId: T, userId: u.id, startedAt: at(8, 2), lastSeenAt: at(17, 3), endedAt: at(17, 3) } });
      const p = (label: string, h: number, m: number, mins: number) => {
        const s = at(h, m);
        return { tenantId: T, extensionId: u.extId, userId: u.id, reasonId: reasons[label]!, startedAt: s, endedAt: sec(s, mins * 60 + rand(-60, 120)) };
      };
      await db.agentPause.createMany({ data: [p('Pause Break', 10, 30, 10), p('Almoço', 12, 30, 45), p('REMUP', 15, 0, 15), p('Pause Break', 16, 0, 8)] });
    }
    // Hoje: ligado desde o início da janela, sessão aberta (a API está a correr).
    await db.agentSession.create({ data: { tenantId: T, userId: u.id, startedAt: sec(todayFrom, rand(0, 300)), lastSeenAt: now } });
    const span = (now.getTime() - todayFrom.getTime()) / 1000;
    await db.agentPause.createMany({
      data: [
        { tenantId: T, extensionId: u.extId, userId: u.id, reasonId: reasons['Pause Break'], startedAt: sec(todayFrom, span * 0.25), endedAt: sec(todayFrom, span * 0.25 + rand(480, 720)) },
        { tenantId: T, extensionId: u.extId, userId: u.id, reasonId: reasons['REMUP'], startedAt: sec(todayFrom, span * 0.6), endedAt: sec(todayFrom, span * 0.6 + rand(600, 1000)) },
      ],
    });
  }

  // ── Chamadas de hoje (histórico) ────────────────────────────────────────────
  const inGroup = (gid: string) => users.filter((u) => u.groupIds.includes(gid));
  const groupList = [G.VENDAS, G.SUPORTE, G.SUPORTE, G.FACTURACAO];
  let n = 0;
  const span = (ago(300).getTime() - todayFrom.getTime()) / 1000;
  for (let i = 0; i < 70; i++) {
    const gid = pick(groupList);
    const members = inGroup(gid);
    if (!members.length) continue;
    const c = pick(contacts);
    const queuedAt = sec(todayFrom, rand(0, span));
    const roll = Math.random();
    const kind = roll < 0.84 ? 'ANSWERED' : roll < 0.94 ? 'ABANDONED' : 'NO_ANSWER';
    const uid = `demo-${++n}`;
    const wait = kind === 'ANSWERED' ? (Math.random() < 0.8 ? rand(3, 19) : rand(21, 75)) : rand(8, 90);
    const talk = rand(70, 420);
    const agent = pick(members);
    const answeredAt = kind === 'ANSWERED' ? sec(queuedAt, wait) : null;
    const endedAt = answeredAt ? sec(answeredAt, talk) : sec(queuedAt, wait);
    const call = await db.call.create({
      data: {
        tenantId: T, kind: 'INBOUND', status: answeredAt ? 'COMPLETED' : 'NO_ANSWER', outcome: answeredAt ? 'COMPLETED' : 'NO_ANSWER',
        toNumber: DID, fromNumber: c.phone, contactId: c.id, yeastarCallId: uid, groupId: gid,
        startedAt: sec(queuedAt, -8), queuedAt, answeredAt, endedAt,
        durationSecs: answeredAt ? talk : 0, billedSecs: answeredAt ? talk : 0, costCents: answeredAt ? Math.ceil(talk / 60) * 25 : 0,
      },
    });
    const typed = Math.random() < 0.9;
    const typing = leaves.length ? pick(leaves) : ['', ''];
    const legs = members.map((m) => {
      const won = answeredAt && m.id === agent.id;
      return {
        tenantId: T, callId: call.id, extensionId: m.extId, extensionNumber: exts.find((e) => e.id === m.extId)!.number, groupId: gid,
        ringStartedAt: sec(queuedAt, 1),
        answeredAt: won ? answeredAt : null,
        endedAt: won ? endedAt : answeredAt ?? endedAt,
        outcome: won ? ('ANSWERED' as const) : kind === 'ABANDONED' || answeredAt ? ('CANCELLED' as const) : ('NO_ANSWER' as const),
        typedAt: won && typed ? sec(endedAt, rand(8, 55)) : null,
        ...(won && typed && leaves.length > 0 && { categoryId: typing[0], subcategoryId: typing[1] }),
      };
    });
    await db.callLeg.createMany({ data: legs });
    if (answeredAt && Math.random() < 0.6) {
      await db.csatResponse.create({
        data: { tenantId: T, channel: 'VOICE', score: pick([5, 5, 5, 4, 4, 4, 3, 2, 1]), callId: call.id, agentId: agent.id, groupId: gid, contactId: c.id, createdAt: endedAt, answeredAt: sec(endedAt, 20) },
      });
    }
  }

  // ── Agora: 2 em chamada, 1 em pós-chamada, 1 em pausa, 3 na fila ───────────
  const byNum = (num: string) => users[AGENTS.findIndex((a) => a.number === num)]!;
  const live = async (u: (typeof users)[number], gid: string, answeredSecsAgo: number) => {
    const c = pick(contacts);
    const answeredAt = ago(answeredSecsAgo);
    const call = await db.call.create({
      data: { tenantId: T, kind: 'INBOUND', status: 'IN_PROGRESS', toNumber: DID, fromNumber: c.phone, contactId: c.id, yeastarCallId: `demo-${++n}`, groupId: gid, startedAt: sec(answeredAt, -20), queuedAt: sec(answeredAt, -12), answeredAt },
    });
    await db.callLeg.create({ data: { tenantId: T, callId: call.id, extensionId: u.extId, extensionNumber: exts.find((e) => e.id === u.extId)!.number, groupId: gid, ringStartedAt: sec(answeredAt, -10), answeredAt, outcome: 'ANSWERED' } });
  };
  await live(byNum('1000'), G.VENDAS, 192); // Ana
  await live(byNum('1001'), G.SUPORTE, 65); // Bruno

  // Edna: acabou há 25 s, ainda a tipificar (pós-chamada, prazo daqui a 30 min).
  {
    const u = byNum('1004');
    const c = pick(contacts);
    const endedAt = ago(25);
    const answeredAt = sec(endedAt, -240);
    const call = await db.call.create({
      data: { tenantId: T, kind: 'INBOUND', status: 'COMPLETED', outcome: 'COMPLETED', toNumber: DID, fromNumber: c.phone, contactId: c.id, yeastarCallId: `demo-${++n}`, groupId: G.FACTURACAO, startedAt: sec(answeredAt, -15), queuedAt: sec(answeredAt, -9), answeredAt, endedAt, durationSecs: 240, billedSecs: 240 },
    });
    await db.callLeg.create({ data: { tenantId: T, callId: call.id, extensionId: u.extId, extensionNumber: '1004', groupId: G.FACTURACAO, ringStartedAt: sec(answeredAt, -8), answeredAt, endedAt, outcome: 'ANSWERED', wrapUpEndsAt: sec(now, 1800) } });
  }

  // Délcio: em pausa para almoço há 12 min.
  {
    const u = byNum('1003');
    const since = ago(12 * 60);
    await db.extension.update({ where: { id: u.extId }, data: { pausedAt: since } });
    await db.agentPause.create({ data: { tenantId: T, extensionId: u.extId, userId: u.id, reasonId: reasons['Almoço'], startedAt: since } });
  }

  // Fila: três à espera (um sem contacto conhecido).
  for (const [gid, secsAgo, known] of [[G.SUPORTE, 95, true], [G.VENDAS, 41, false], [G.FACTURACAO, 14, true]] as const) {
    const c = pick(contacts);
    await db.call.create({
      data: { tenantId: T, kind: 'INBOUND', status: 'RINGING', toNumber: DID, fromNumber: known ? c.phone : '+244930000000', ...(known && { contactId: c.id }), yeastarCallId: `demo-${++n}`, groupId: gid, startedAt: ago(secsAgo + 15), queuedAt: ago(secsAgo) },
    });
  }

  // ── Callbacks: 2 à espera de agente, 3 feitos, 1 falhado ───────────────────
  const carla = byNum('1002');
  const bruno = byNum('1001');
  await db.queueCallback.createMany({
    data: [
      { tenantId: T, groupId: G.SUPORTE, number: pick(contacts).phone!, createdAt: ago(6 * 60) },
      { tenantId: T, groupId: G.VENDAS, number: pick(contacts).phone!, createdAt: ago(2 * 60) },
      { tenantId: T, groupId: G.SUPORTE, number: pick(contacts).phone!, status: 'DONE', attempts: 1, assignedToId: carla.id, assignedAt: ago(3 * 3600), closedAt: ago(3 * 3600 - 240), createdAt: ago(3 * 3600 + 300) },
      { tenantId: T, groupId: G.VENDAS, number: pick(contacts).phone!, status: 'DONE', attempts: 2, assignedToId: bruno.id, assignedAt: ago(2 * 3600), closedAt: ago(2 * 3600 - 180), createdAt: ago(2 * 3600 + 900) },
      { tenantId: T, groupId: G.FACTURACAO, number: pick(contacts).phone!, status: 'DONE', attempts: 1, assignedToId: carla.id, assignedAt: ago(5400), closedAt: ago(5200), createdAt: ago(5500) },
      { tenantId: T, groupId: G.SUPORTE, number: pick(contacts).phone!, status: 'FAILED', attempts: 3, assignedToId: bruno.id, assignedAt: ago(4 * 3600), closedAt: ago(4 * 3600 - 60), createdAt: ago(5 * 3600) },
    ],
  });

  console.log(`OK — ${n} chamadas demo, ${users.length} agentes, conta da sala: sala@demo.com / ${PASSWORD}`);
  console.log('Agentes:', AGENTS.map((a) => a.email).join(', '), '(password nova só nas contas criadas agora)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
