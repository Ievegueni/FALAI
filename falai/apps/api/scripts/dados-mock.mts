/**
 * Dados de demonstração das melhorias 1–4 (relatórios, tipificação, screen pop,
 * supervisão) no tenant de demo — SÓ PARA DESENVOLVIMENTO.
 *
 * Cria ~120 dias de chamadas de entrada com pernas (atendidas, recusadas com
 * motivo, não atendidas, abandonadas), tipificação, contactos com notas e
 * números extra, chamadas de hoje (fila, pós-chamada) e supervisões no registo.
 * Tudo com o prefixo "mock_", para se poder apagar.
 *
 *   pnpm -F api dados:mock            cria (apaga os mock anteriores primeiro)
 *   pnpm -F api dados:mock --limpar   só apaga
 *
 * Recusa correr fora de uma base local.
 */
import { prisma } from "@falai/db";
import { hashPassword } from "../src/services/auth.service.js";

const TENANT = process.env["MOCK_TENANT"] ?? "tenant_demo";
const DID = "244959100354";
const P = "mock_";

const url = process.env["DATABASE_URL"] ?? "";
if (process.env["NODE_ENV"] === "production" || !/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("Recusado: só corre contra uma base de dados local.");
  process.exit(1);
}

// Gerador determinístico: os mesmos números em cada corrida.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p: number) => rnd() < p;
const add = (d: Date, secs: number) => new Date(d.getTime() + secs * 1000);

const AGENT_NAMES: Record<string, string> = {
  "1000": "Ana Costa",
  "1001": "Bruno Mendes",
  "1002": "Carla Neto",
  "1003": "Délcio Fernandes",
  "1004": "Edna Pires",
};
// Perfil de cada agente: quão depressa atende, quanto recusa, quanto fala.
const PROFILE: Record<string, { answer: number; reject: number; resp: [number, number]; talk: [number, number]; typing: number }> = {
  "1000": { answer: 0.9, reject: 0.03, resp: [2, 6], talk: [60, 300], typing: 0.95 },
  "1001": { answer: 0.75, reject: 0.12, resp: [4, 14], talk: [90, 480], typing: 0.7 },
  "1002": { answer: 0.85, reject: 0.05, resp: [3, 9], talk: [45, 240], typing: 0.9 },
  "1003": { answer: 0.6, reject: 0.2, resp: [6, 18], talk: [120, 600], typing: 0.55 },
  "1004": { answer: 0.8, reject: 0.08, resp: [3, 10], talk: [60, 360], typing: 0.85 },
};

async function clean(): Promise<void> {
  const like = { startsWith: P };
  // Registo de supervisões é imutável (trigger); em dev desliga-se só para apagar os mock.
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupervisionEvent" DISABLE TRIGGER supervision_event_no_update_delete`);
  await prisma.supervisionEvent.deleteMany({ where: { tenantId: TENANT, sessionId: like } });
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupervisionEvent" ENABLE TRIGGER supervision_event_no_update_delete`);
  await prisma.auditLog.deleteMany({ where: { tenantId: TENANT, targetId: like } });
  await prisma.contactNote.deleteMany({ where: { tenantId: TENANT, id: like } });
  await prisma.contactPhone.deleteMany({ where: { tenantId: TENANT, id: like } });
  await prisma.callLeg.deleteMany({ where: { tenantId: TENANT, id: like } });
  await prisma.call.deleteMany({ where: { tenantId: TENANT, id: like } });
  await prisma.callCategory.deleteMany({ where: { tenantId: TENANT, id: like, parentId: { not: null } } });
  await prisma.callCategory.deleteMany({ where: { tenantId: TENANT, id: like } });
  await prisma.rejectReason.deleteMany({ where: { tenantId: TENANT, id: like } });
  await prisma.supervisorGroup.deleteMany({ where: { user: { id: like } } });
  await prisma.tenantUser.deleteMany({ where: { tenantId: TENANT, id: like } });
  // Nomes dos agentes voltam a ser só o número.
  for (const n of Object.keys(AGENT_NAMES)) {
    await prisma.extension.updateMany({ where: { tenantId: TENANT, number: n, displayName: AGENT_NAMES[n] }, data: { displayName: n } });
  }
}

async function main(): Promise<void> {
  await clean();
  if (process.argv.includes("--limpar")) {
    console.log("mock apagados.");
    return;
  }

  const exts = await prisma.extension.findMany({ where: { tenantId: TENANT, isActive: true }, select: { id: true, number: true } });
  const extByNum = new Map(exts.map((e) => [e.number, e.id]));
  for (const [n, name] of Object.entries(AGENT_NAMES)) {
    await prisma.extension.updateMany({ where: { tenantId: TENANT, number: n }, data: { displayName: name } });
  }
  const groups = await prisma.extensionGroup.findMany({
    where: { tenantId: TENANT, name: { in: ["VENDAS", "SUPORTE", "FACTURACAO"] } },
    select: { id: true, name: true, members: { select: { extension: { select: { number: true } } } } },
  });
  const groupMembers = new Map(groups.map((g) => [g.id, g.members.map((m) => m.extension.number)]));

  // ── Motivos de recusa e categorias (os que já existem ficam; juntam-se mock) ──
  const reasons = [
    ...(await prisma.rejectReason.findMany({ where: { tenantId: TENANT, isActive: true }, select: { id: true } })).map((r) => r.id),
  ];
  for (const [i, label] of ["A atender outra chamada", "Pausa para almoço", "Problema técnico"].entries()) {
    const exists = await prisma.rejectReason.findFirst({ where: { tenantId: TENANT, label } });
    if (!exists) reasons.push((await prisma.rejectReason.create({ data: { id: `${P}rr_${i}`, tenantId: TENANT, label, sortOrder: 10 + i } })).id);
  }
  const tree: [string, string[]][] = [
    ["Reclamação", ["Facturação", "Atendimento", "Rede / serviço"]],
    ["Informação", ["Preços", "Horários", "Estado do pedido"]],
    ["Vendas", ["Novo cliente", "Renovação", "Upgrade de plano"]],
    ["Suporte técnico", ["Sem serviço", "Configuração", "Equipamento"]],
  ];
  const typing: { cat: string; sub: string }[] = [];
  for (const [ci, [name, subs]] of tree.entries()) {
    let cat = await prisma.callCategory.findFirst({ where: { tenantId: TENANT, parentId: null, name } });
    cat ??= await prisma.callCategory.create({ data: { id: `${P}cat_${ci}`, tenantId: TENANT, name, sortOrder: ci } });
    for (const [si, sub] of subs.entries()) {
      let s = await prisma.callCategory.findFirst({ where: { tenantId: TENANT, parentId: cat.id, name: sub } });
      s ??= await prisma.callCategory.create({ data: { id: `${P}sub_${ci}_${si}`, tenantId: TENANT, parentId: cat.id, name: sub, sortOrder: si } });
      typing.push({ cat: cat.id, sub: s.id });
    }
  }
  // Pesos: reclamações de facturação e pedidos de informação são o grosso.
  const typingWeights = [9, 4, 3, 7, 3, 4, 3, 2, 2, 4, 3, 2];
  const pickTyping = () => {
    let r = rnd() * typingWeights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < typing.length; i++) if ((r -= typingWeights[i] ?? 1) < 0) return typing[i]!;
    return typing[0]!;
  };
  const notes = ["Cliente satisfeito", "Pediu 2.ª via da factura", "Vai ligar mais tarde", "Escalado para o técnico", "Pediu desconto", "Problema resolvido na chamada", null, null, null];

  // ── Contactos: 70% das chamadas vêm de contactos conhecidos ──
  const contacts = await prisma.contact.findMany({ where: { tenantId: TENANT, phone: { not: null } }, select: { id: true, phone: true }, take: 60 });
  const regulars = contacts.slice(0, 12); // clientes que ligam muitas vezes

  // ── Chamadas dos últimos 30 dias ──
  const calls: Parameters<typeof prisma.call.createMany>[0]["data"] = [];
  const legs: Parameters<typeof prisma.callLeg.createMany>[0]["data"] = [];
  const now = new Date();
  let n = 0;
  const groupList = groups.map((g) => g.id);

  const makeCall = (startedAt: Date, opts: { live?: "queued" | "wrapup" } = {}) => {
    const id = `${P}c_${++n}`;
    const groupId = chance(0.12) ? null : pick(groupList);
    const targets = groupId ? groupMembers.get(groupId)! : [pick(Object.keys(AGENT_NAMES))];
    const contact = chance(0.35) ? pick(regulars) : chance(0.55) ? pick(contacts) : null;
    const hidden = !contact && chance(0.15);
    const fromNumber = contact ? `+244${contact.phone}` : hidden ? "anonymous" : `+2449${between(10000000, 99999999)}`;
    const queuedAt = add(startedAt, chance(0.6) ? between(4, 25) : 1); // IVR antes de tocar

    let answeredAt: Date | null = null;
    let endedAt: Date | null = null;
    let answeredExt: string | null = null;
    const abandonAfter = chance(0.08) ? between(3, 15) : null; // quem liga desiste a tocar

    // Cada extensão decide: atende, recusa, ocupado ou deixa tocar.
    const decisions = targets.map((num) => {
      const p = PROFILE[num]!;
      const r = rnd();
      const resp = between(p.resp[0], p.resp[1]);
      return { num, resp, act: r < p.reject ? "REJECTED" : r < p.reject + 0.04 ? "BUSY" : chance(p.answer) ? "ANSWER" : "NO_ANSWER" };
    });
    const winner = opts.live === "queued" || abandonAfter !== null
      ? null
      : decisions.filter((d) => d.act === "ANSWER").sort((a, b) => a.resp - b.resp)[0] ?? null;

    if (winner) {
      answeredExt = winner.num;
      answeredAt = add(queuedAt, winner.resp);
      const talk = between(PROFILE[winner.num]!.talk[0], PROFILE[winner.num]!.talk[1]);
      endedAt = opts.live === "wrapup" ? add(now, -between(10, 40)) : add(answeredAt, talk);
      if (opts.live === "wrapup") answeredAt = add(endedAt, -talk);
    } else if (opts.live !== "queued") {
      endedAt = add(queuedAt, abandonAfter ?? 25);
    }

    const talkSecs = answeredAt && endedAt ? Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000) : 0;
    calls.push({
      id,
      tenantId: TENANT,
      kind: "INBOUND",
      status: opts.live === "queued" ? "RINGING" : answeredAt ? "COMPLETED" : "NO_ANSWER",
      outcome: answeredAt ? "COMPLETED" : opts.live === "queued" ? null : "NO_ANSWER",
      toNumber: DID,
      fromNumber,
      contactId: contact?.id ?? null,
      yeastarCallId: id,
      startedAt,
      createdAt: startedAt, // o Resumo agrupa por createdAt: tem de bater com a data da chamada
      queuedAt,
      answeredAt,
      endedAt,
      groupId,
      durationSecs: talkSecs,
      billedSecs: talkSecs,
      costCents: answeredAt ? Math.ceil(talkSecs / 60) * 30 : 0,
    });

    decisions.forEach((d, j) => {
      const isWinner = winner?.num === d.num;
      // Um colega atendeu antes de este agente decidir: a perna dele foi cancelada.
      const beaten = winner !== null && !isWinner && winner.resp <= d.resp;
      const t = pickTyping();
      const typed = isWinner && opts.live !== "wrapup" && chance(PROFILE[d.num]!.typing);
      const ringEnd = add(queuedAt, Math.min(d.resp, 25));
      legs.push({
        id: `${id.replace("_c_", "_l_")}_${j}`,
        tenantId: TENANT,
        callId: id,
        extensionId: extByNum.get(d.num) ?? null,
        extensionNumber: d.num,
        groupId,
        ringStartedAt: queuedAt,
        answeredAt: isWinner ? answeredAt : null,
        endedAt: opts.live === "queued" ? null : isWinner ? endedAt : abandonAfter !== null ? add(queuedAt, abandonAfter) : winner ? answeredAt : ringEnd,
        outcome:
          opts.live === "queued" ? null
          : isWinner ? "ANSWERED"
          : abandonAfter !== null ? "CANCELLED"
          : beaten || (winner && d.act !== "REJECTED") ? "CANCELLED"
          : d.act === "ANSWER" ? "NO_ANSWER"
          : (d.act as "REJECTED" | "BUSY" | "NO_ANSWER"),
        hangupCause: beaten ? null : d.act === "REJECTED" ? 21 : d.act === "BUSY" ? 17 : null,
        // No webphone o motivo é obrigatório; no telefone físico não há (≈15% "Sem motivo").
        rejectReasonId: d.act === "REJECTED" && !beaten && chance(0.85) ? pick(reasons) : null,
        rejectNote: d.act === "REJECTED" && !beaten && chance(0.05) ? "Estava a meio de outro atendimento" : null,
        ...(typed && {
          categoryId: t.cat,
          subcategoryId: t.sub,
          typingNote: pick(notes),
          typedAt: add(endedAt!, between(5, 50)),
        }),
        wrapUpEndsAt: isWinner && endedAt ? add(endedAt, opts.live === "wrapup" ? 240 : 60) : null,
      });
    });
  };

  // 120 dias, a crescer (~+35% do mais antigo ao mais recente): os períodos
  // de 7/30/90 dias têm sempre um anterior com que comparar.
  for (let day = 120; day >= 0; day--) {
    const date = new Date(now);
    date.setDate(date.getDate() - day);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const growth = 1 - day / 400;
    const perDay = Math.round((weekend ? between(4, 10) : between(18, 40)) * growth);
    for (let i = 0; i < perDay; i++) {
      const t = new Date(date);
      // Mais chamadas de manhã (pico 9–11h) e depois do almoço.
      t.setHours(chance(0.55) ? between(8, 11) : between(13, 17), between(0, 59), between(0, 59), 0);
      if (t > add(now, -120)) continue; // nada no futuro
      makeCall(t);
    }
  }
  // Chamadas de saída (directas, feitas pelos agentes): o dashboard separa
  // recebidas de efectuadas e os relatórios mostram as duas direcções.
  for (let day = 120; day >= 0; day--) {
    const date = new Date(now);
    date.setDate(date.getDate() - day);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    for (let i = 0, k = between(3, 9); i < k; i++) {
      const t = new Date(date);
      t.setHours(between(9, 17), between(0, 59), between(0, 59), 0);
      if (t > add(now, -120)) continue;
      const contact = pick(contacts);
      const answered = chance(0.7);
      const talk = answered ? between(40, 420) : 0;
      const id = `${P}c_${++n}`;
      calls.push({
        id,
        tenantId: TENANT,
        kind: "DIRECT",
        status: answered ? "COMPLETED" : "NO_ANSWER",
        outcome: answered ? "COMPLETED" : "NO_ANSWER",
        toNumber: contact.phone!,
        fromNumber: pick(Object.keys(AGENT_NAMES)),
        contactId: contact.id,
        yeastarCallId: id,
        startedAt: t,
        createdAt: t,
        answeredAt: answered ? add(t, between(4, 20)) : null,
        endedAt: add(t, answered ? talk + 10 : 30),
        durationSecs: talk,
        billedSecs: talk,
        costCents: answered ? Math.ceil(talk / 60) * 30 : 0,
      });
    }
  }

  // Agora: 2 em fila e 1 agente em pós-chamada (para o painel de supervisão).
  makeCall(add(now, -40), { live: "queued" });
  makeCall(add(now, -15), { live: "queued" });
  makeCall(add(now, -300), { live: "wrapup" });

  await prisma.call.createMany({ data: calls });
  await prisma.callLeg.createMany({ data: legs });

  // ── Screen pop: números extra e notas nos clientes habituais ──
  const author = await prisma.tenantUser.findFirstOrThrow({ where: { tenantId: TENANT, role: "OWNER" }, select: { id: true } });
  for (const [i, c] of regulars.slice(0, 4).entries()) {
    const phone = `9${between(20000000, 99999999)}`;
    const free = !(await prisma.contact.findFirst({ where: { tenantId: TENANT, phone } }));
    if (free) await prisma.contactPhone.create({ data: { id: `${P}ph_${i}`, tenantId: TENANT, contactId: c.id, phone, label: pick(["Trabalho", "Casa", "Outro"]) } });
  }
  const noteTexts = [
    "Cliente VIP — tratar com prioridade.",
    "Prefere ser contactado depois das 14h.",
    "Reclamou duas vezes da mesma factura; ver histórico antes de responder.",
    "Interessado no plano empresarial.",
  ];
  for (const [i, c] of regulars.slice(0, 8).entries()) {
    await prisma.contactNote.create({
      data: { id: `${P}nt_${i}`, tenantId: TENANT, contactId: c.id, authorId: author.id, body: noteTexts[i % noteTexts.length]!, createdAt: add(now, -between(1, 20) * 86400) },
    });
  }

  // ── Supervisão: utilizador supervisor e algumas sessões no registo ──
  const supEmail = "supervisor@demo.com";
  const existingSup = await prisma.tenantUser.findUnique({ where: { email: supEmail } });
  const sup =
    existingSup ??
    (await prisma.tenantUser.create({
      data: {
        id: `${P}user_sup`,
        tenantId: TENANT,
        name: "Sofia Supervisora",
        email: supEmail,
        role: "SUPERVISOR",
        passwordHash: await hashPassword("Supervisor123!"),
      },
    }));
  for (const g of groups.filter((g) => g.name !== "SUPORTE")) {
    await prisma.supervisorGroup.upsert({
      where: { tenantUserId_groupId: { tenantUserId: sup.id, groupId: g.id } },
      create: { tenantUserId: sup.id, groupId: g.id },
      update: {},
    });
  }
  // Só se supervisionam chamadas de entrada (as que têm agente/perna).
  const answered = calls.filter((c) => c.kind === "INBOUND" && c.answeredAt && c.endedAt && (c.startedAt as Date) < add(now, -86400));
  const events: Parameters<typeof prisma.supervisionEvent.createMany>[0]["data"] = [];
  for (let i = 0; i < 14; i++) {
    const c = pick(answered);
    const leg = legs.find((l) => l.callId === c.id && l.outcome === "ANSWERED")!;
    const start = add(c.answeredAt as Date, between(5, 30));
    const end = new Date(Math.min((c.endedAt as Date).getTime(), add(start, between(30, 180)).getTime()));
    const sessionId = `${P}sv_${i}`;
    const supervisorId = chance(0.6) ? sup.id : author.id;
    const base = { tenantId: TENANT, sessionId, supervisorId, agentExtensionId: leg.extensionId, agentExtension: leg.extensionNumber, callId: c.id, contactId: c.contactId ?? null };
    events.push({ ...base, id: `${sessionId}_0`, type: "START", mode: "LISTEN", at: start });
    if (chance(0.5)) events.push({ ...base, id: `${sessionId}_1`, type: "MODE", mode: "WHISPER", at: add(start, between(10, 25)) });
    if (chance(0.2)) events.push({ ...base, id: `${sessionId}_2`, type: "MODE", mode: "BARGE", at: add(start, 28) });
    const endedByCall = end.getTime() === (c.endedAt as Date).getTime();
    events.push({ ...base, id: `${sessionId}_9`, type: "END", at: end, endReason: endedByCall ? "CALL_ENDED" : "SUPERVISOR" });
  }
  await prisma.supervisionEvent.createMany({ data: events });

  const inbound = calls.filter((c) => c.kind === "INBOUND");
  const answeredCount = inbound.filter((c) => c.answeredAt).length;
  console.log(`chamadas: ${calls.length} — entrada ${inbound.length} (atendidas ${answeredCount}, perdidas ${inbound.length - answeredCount - 2}, em fila 2), saída ${calls.length - inbound.length}`);
  console.log(`pernas: ${legs.length}; recusas: ${legs.filter((l) => l.outcome === "REJECTED").length}`);
  console.log(`tipificadas: ${legs.filter((l) => l.typedAt).length}; supervisões no registo: 14`);
  console.log(`supervisor: ${supEmail} / Supervisor123! (VENDAS + FACTURACAO)`);
}

await main();
await prisma.$disconnect();
