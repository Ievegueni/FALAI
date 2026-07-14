/**
 * seed-demo.ts — dados realistas para avaliação da plataforma
 *
 * Cria: 3 tenants, agentes, 300 contactos, ~500 chamadas (30 dias),
 *       3 campanhas, transacções de carteira, transcripts de chamadas.
 *
 * Uso: pnpm tsx scripts/seed-demo.ts
 */

import { PrismaClient, CallStatus, TxType, CampaignStatus, CampaignContactStatus, TenantStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const db = new PrismaClient();

// ── Utilitários ────────────────────────────────────────────────────────────────

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function daysAgo(n: number, offsetHours = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(offsetHours, rand(0, 59), rand(0, 59), 0);
  return d;
}
function addSeconds(date: Date, secs: number): Date {
  return new Date(date.getTime() + secs * 1000);
}
async function hash(p: string) {
  return argon2.hash(p, { type: argon2.argon2id });
}

// ── Dados fictícios angolanos ──────────────────────────────────────────────────

const ANGOLA_PHONES = () => {
  const prefixes = ['923', '924', '925', '926', '927', '931', '932', '933', '934', '935', '941', '942', '943'];
  return `+244${pick(prefixes)}${String(rand(100000, 999999))}`;
};

const FIRST_NAMES = ['Ana', 'Carlos', 'Maria', 'João', 'Sofia', 'Pedro', 'Luísa', 'Miguel', 'Beatriz', 'Rui',
  'Fernanda', 'António', 'Sandra', 'Marcos', 'Paula', 'David', 'Helena', 'Nelson', 'Carla', 'Filipe',
  'Amélia', 'Eduardo', 'Cristina', 'Tomás', 'Vanessa', 'Jorge', 'Inês', 'Manuel', 'Teresa', 'Bruno'];
const LAST_NAMES = ['Silva', 'Santos', 'Costa', 'Ferreira', 'Oliveira', 'Sousa', 'Rodrigues', 'Martins',
  'Pereira', 'Alves', 'Fernandes', 'Gonçalves', 'Lopes', 'Marques', 'Nunes', 'Teixeira', 'Carvalho',
  'Moreira', 'Correia', 'Mendes', 'Nascimento', 'Pinto', 'Dias', 'Henriques', 'Baptista'];

function randomName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

// Outcomes ponderados para chamadas (somam 100)
const CALL_OUTCOMES: { status: CallStatus; weight: number; outcome?: string }[] = [
  { status: 'COMPLETED', weight: 55, outcome: 'interest' },
  { status: 'COMPLETED', weight: 10, outcome: 'callback_requested' },
  { status: 'COMPLETED', weight: 5,  outcome: 'opted_out' },
  { status: 'NO_ANSWER', weight: 15 },
  { status: 'BUSY',      weight: 7 },
  { status: 'FAILED',    weight: 5 },
  { status: 'CANCELLED', weight: 3 },
];

function pickCallOutcome() {
  const total = CALL_OUTCOMES.reduce((s, o) => s + o.weight, 0);
  let r = rand(0, total - 1);
  for (const o of CALL_OUTCOMES) {
    if (r < o.weight) return o;
    r -= o.weight;
  }
  return CALL_OUTCOMES[0]!;
}

// Transcrições de exemplo
const SAMPLE_TURNS: { role: 'AGENT' | 'HUMAN'; text: string }[][] = [
  [
    { role: 'AGENT', text: 'Olá! Falo da BancaPlus. Estou a ligar sobre uma oferta especial de crédito pessoal. Tem um momento?' },
    { role: 'HUMAN', text: 'Sim, pode falar.' },
    { role: 'AGENT', text: 'Excelente! Temos uma taxa de juro de apenas 12% ao ano para clientes seleccionados. O valor disponível para si é até 2 milhões de kwanzas. Tem interesse?' },
    { role: 'HUMAN', text: 'Interessante. Que documentos preciso?' },
    { role: 'AGENT', text: 'Apenas o bilhete de identidade e os últimos três recibos de vencimento. O processo é feito em 48 horas. Posso agendar uma visita a uma das nossas agências?' },
    { role: 'HUMAN', text: 'Sim, prefiro na próxima semana.' },
    { role: 'AGENT', text: 'Perfeito! Vou registar o seu interesse. Alguém da nossa equipa entrará em contacto para confirmar a data. Obrigado pela atenção!' },
  ],
  [
    { role: 'AGENT', text: 'Bom dia! Sou a assistente virtual da Seguros Angola. Ligo porque o seu seguro de saúde vence em breve. Gostaria de renovar?' },
    { role: 'HUMAN', text: 'Não tenho interesse.' },
    { role: 'AGENT', text: 'Compreendo. Posso perguntar o motivo para melhorarmos o nosso serviço?' },
    { role: 'HUMAN', text: 'O preço está muito alto.' },
    { role: 'AGENT', text: 'Entendo. Temos planos mais acessíveis a partir de 15.000 kwanzas por mês. Gostaria que lhe enviasse informação por SMS?' },
    { role: 'HUMAN', text: 'Pode enviar.' },
  ],
  [
    { role: 'AGENT', text: 'Olá, boa tarde! Falo em nome da Telecomunica. Tem o nosso serviço de internet há 2 anos e queremos oferecer-lhe um upgrade gratuito.' },
    { role: 'HUMAN', text: 'Upgrade de quê?' },
    { role: 'AGENT', text: 'A velocidade da sua ligação passaria de 20 Mbps para 50 Mbps sem custo adicional nos próximos 3 meses. Depois o valor seria revisto.' },
    { role: 'HUMAN', text: 'Qual o valor depois?' },
    { role: 'AGENT', text: 'Seria 35.000 kwanzas por mês, comparado com os 22.000 actuais. É um aumento, mas com o dobro da velocidade.' },
    { role: 'HUMAN', text: 'Não me interessa por agora, obrigado.' },
    { role: 'AGENT', text: 'Claro, sem problema. Fico à disposição se mudar de ideias. Tenha um bom dia!' },
  ],
];

// ── MAIN ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱 Seed de dados de demonstração Falaí\n');

  // ── Planos (garantir existência) ──────────────────────────────────────────
  const planStarter = await db.plan.upsert({
    where: { id: 'plan_starter' },
    update: {},
    create: {
      id: 'plan_starter', name: 'Starter',
      pricePerMinuteCents: 150, pricePerCallCents: 0,
      monthlyFeeCents: 500_000, maxAgents: 5, maxConcurrent: 3, sttMarginPct: 20, isActive: true,
    },
  });
  const planPro = await db.plan.upsert({
    where: { id: 'plan_pro' },
    update: {},
    create: {
      id: 'plan_pro', name: 'Pro',
      pricePerMinuteCents: 100, pricePerCallCents: 0,
      monthlyFeeCents: 1_500_000, maxAgents: 20, maxConcurrent: 10, sttMarginPct: 20, isActive: true,
    },
  });
  console.log('✅ Planos: Starter, Pro');

  // ── Admin ─────────────────────────────────────────────────────────────────
  await db.adminUser.upsert({
    where: { email: 'admin@comunica.ao' },
    update: { passwordHash: await hash('admin123') },
    create: {
      email: 'admin@comunica.ao', name: 'Super Admin',
      passwordHash: await hash('admin123'), role: 'SUPERADMIN',
    },
  });
  console.log('✅ Admin: admin@comunica.ao / admin123');

  // ── Tenant 1 — Demo Company (já existe) ────────────────────────────────────
  const t1 = await db.tenant.upsert({
    where: { id: 'tenant_demo' },
    update: { status: 'ACTIVE', balanceCents: 8_000_000 },
    create: {
      id: 'tenant_demo', name: 'Demo Company', email: 'demo@demo.com',
      phone: '+244923000000', planId: planStarter.id, status: 'ACTIVE',
      balanceCents: 8_000_000, maxConcurrent: 3,
      webhookSecret: randomBytes(16).toString('hex'),
    },
  });
  await db.tenantUser.upsert({
    where: { email: 'demo@demo.com' },
    update: { passwordHash: await hash('demo123') },
    create: {
      email: 'demo@demo.com', name: 'Demo User',
      passwordHash: await hash('demo123'), role: 'OWNER', tenantId: t1.id,
    },
  });

  // ── Tenant 2 — BancaPlus (banco fictício) ──────────────────────────────────
  const t2 = await db.tenant.upsert({
    where: { id: 'tenant_bancaplus' },
    update: {},
    create: {
      id: 'tenant_bancaplus', name: 'BancaPlus', email: 'ops@bancaplus.ao',
      phone: '+244926100200', planId: planPro.id, status: 'ACTIVE',
      balanceCents: 25_000_000, maxConcurrent: 8,
      webhookSecret: randomBytes(16).toString('hex'),
    },
  });
  await db.tenantUser.upsert({
    where: { email: 'ops@bancaplus.ao' },
    update: {},
    create: {
      email: 'ops@bancaplus.ao', name: 'Operador BancaPlus',
      passwordHash: await hash('banca123'), role: 'OWNER', tenantId: t2.id,
    },
  });
  await db.tenantUser.upsert({
    where: { email: 'supervisor@bancaplus.ao' },
    update: {},
    create: {
      email: 'supervisor@bancaplus.ao', name: 'Supervisora',
      passwordHash: await hash('banca123'), role: 'ADMIN', tenantId: t2.id,
    },
  });

  // ── Tenant 3 — Telecomunica ────────────────────────────────────────────────
  const t3 = await db.tenant.upsert({
    where: { id: 'tenant_telecom' },
    update: {},
    create: {
      id: 'tenant_telecom', name: 'Telecomunica', email: 'suporte@telecom.ao',
      phone: '+244924300400', planId: planStarter.id, status: 'ACTIVE',
      balanceCents: 12_000_000, maxConcurrent: 3,
      webhookSecret: randomBytes(16).toString('hex'),
    },
  });
  await db.tenantUser.upsert({
    where: { email: 'suporte@telecom.ao' },
    update: {},
    create: {
      email: 'suporte@telecom.ao', name: 'Gestor Telecomunica',
      passwordHash: await hash('telecom123'), role: 'OWNER', tenantId: t3.id,
    },
  });

  console.log('✅ Tenants: Demo Company, BancaPlus, Telecomunica');

  // ── Agentes ───────────────────────────────────────────────────────────────
  const agentDefs = [
    // Demo Company
    {
      id: 'agent_demo_cobranca', tenantId: t1.id,
      name: 'Agente de Cobrança', description: 'Cobrança amigável de faturas em atraso',
      systemPrompt: 'És um agente de cobrança amigável da Demo Company. Contacta clientes com faturas em atraso, explica o valor em dívida, e oferece planos de pagamento flexíveis. Sê sempre educado e empático.',
      ttsVoiceId: 'pt-AO-female-1', status: 'ACTIVE' as const, isApproved: true,
    },
    {
      id: 'agent_demo_satisfacao', tenantId: t1.id,
      name: 'Pesquisa de Satisfação', description: 'Recolha de NPS e feedback dos clientes',
      systemPrompt: 'És um agente de pesquisa de satisfação da Demo Company. Pergunta ao cliente como avalia o serviço numa escala de 0 a 10 e recolhe feedback qualitativo de forma natural e concisa.',
      ttsVoiceId: 'pt-AO-female-2', status: 'ACTIVE' as const, isApproved: true,
    },
    // BancaPlus
    {
      id: 'agent_banca_credito', tenantId: t2.id,
      name: 'Crédito Pessoal', description: 'Prospecção para crédito pessoal',
      systemPrompt: 'És um agente de vendas da BancaPlus. Apresenta as condições de crédito pessoal, qualifica o cliente e encaminha para a agência mais próxima quando há interesse.',
      ttsVoiceId: 'pt-AO-male-1', status: 'ACTIVE' as const, isApproved: true,
    },
    {
      id: 'agent_banca_seguros', tenantId: t2.id,
      name: 'Seguros de Vida', description: 'Upsell de seguros de vida para clientes activos',
      systemPrompt: 'És um agente da BancaPlus especializado em seguros de vida. Explica os benefícios dos planos disponíveis e marca reuniões com gestores de conta.',
      ttsVoiceId: 'pt-AO-female-1', status: 'ACTIVE' as const, isApproved: true,
    },
    // Telecomunica
    {
      id: 'agent_telecom_renovacao', tenantId: t3.id,
      name: 'Renovação de Contrato', description: 'Retenção de clientes com contratos a vencer',
      systemPrompt: 'És um agente de retenção da Telecomunica. Contacta clientes cujos contratos vencem em breve, apresenta ofertas de renovação e negoceia condições atractivas.',
      ttsVoiceId: 'pt-AO-female-2', status: 'ACTIVE' as const, isApproved: true,
    },
  ];

  for (const a of agentDefs) {
    await db.agent.upsert({
      where: { id: a.id },
      update: {},
      create: { ...a, language: 'pt-AO', sttModel: 'default', maxTurnSeconds: 30, maxCallSeconds: 300 },
    });
  }
  console.log(`✅ Agentes: ${agentDefs.length} criados`);

  // ── Contactos ─────────────────────────────────────────────────────────────
  const tenantContacts: Record<string, { id: string; phone: string }[]> = {
    [t1.id]: [], [t2.id]: [], [t3.id]: [],
  };

  const contactCounts = { [t1.id]: 80, [t2.id]: 150, [t3.id]: 100 };

  for (const [tenantId, count] of Object.entries(contactCounts)) {
    const usedPhones = new Set<string>();
    for (let i = 0; i < count; i++) {
      let phone = ANGOLA_PHONES();
      while (usedPhones.has(phone)) phone = ANGOLA_PHONES();
      usedPhones.add(phone);

      const contact = await db.contact.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        update: {},
        create: {
          tenantId, phone, name: randomName(),
          attributes: {
            cidade: pick(['Luanda', 'Benguela', 'Huambo', 'Lubango', 'Malanje']),
            segmento: pick(['varejo', 'premium', 'corporate', 'sme']),
          },
          optedOutAt: Math.random() < 0.04 ? daysAgo(rand(1, 20)) : null,
        },
      });
      tenantContacts[tenantId]!.push({ id: contact.id, phone: contact.phone });
    }
    console.log(`✅ Contactos ${tenantId}: ${count}`);
  }

  // ── Função para criar chamadas históricas ─────────────────────────────────
  async function createCall(params: {
    tenantId: string;
    agentId: string;
    contact: { id: string; phone: string };
    campaignId?: string;
    daysBack: number;
    withTranscript?: boolean;
  }) {
    const { tenantId, agentId, contact, campaignId, daysBack, withTranscript } = params;
    const outcome = pickCallOutcome();
    const hour = rand(8, 18);
    const startedAt = daysAgo(daysBack, hour);

    let answeredAt: Date | null = null;
    let endedAt: Date | null = null;
    let durationSecs = 0;
    let billedSecs = 0;
    let costCents = 0;

    if (outcome.status === 'COMPLETED') {
      const dialDelay = rand(5, 20);
      answeredAt = addSeconds(startedAt, dialDelay);
      durationSecs = rand(45, 420);
      endedAt = addSeconds(answeredAt, durationSecs);
      billedSecs = durationSecs;
      // 150 Kz/min → 2.5 Kz/s
      costCents = Math.round((billedSecs / 60) * 150);
    } else if (outcome.status === 'NO_ANSWER') {
      endedAt = addSeconds(startedAt, rand(30, 90));
    } else if (outcome.status === 'BUSY') {
      endedAt = addSeconds(startedAt, rand(5, 15));
    } else if (outcome.status === 'FAILED') {
      endedAt = addSeconds(startedAt, rand(2, 8));
    } else if (outcome.status === 'CANCELLED') {
      endedAt = addSeconds(startedAt, rand(1, 5));
    }

    const transcript = withTranscript && outcome.status === 'COMPLETED'
      ? pick(SAMPLE_TURNS).map((t, i) => ({ seq: i + 1, ...t }))
      : null;

    const summary = outcome.status === 'COMPLETED'
      ? pick([
          'Cliente demonstrou interesse. Agendada visita à agência.',
          'Cliente pediu callback para a próxima semana.',
          'Cliente não tem interesse no momento.',
          'Cliente solicitou informação por SMS/email.',
          'Conversa positiva, cliente vai pensar.',
          'Cliente já tem produto similar noutro banco.',
        ])
      : null;

    const call = await db.call.create({
      data: {
        tenantId, agentId, contactId: contact.id, toNumber: contact.phone,
        campaignId: campaignId ?? null,
        status: outcome.status,
        outcome: outcome.outcome ?? null,
        startedAt, answeredAt, endedAt,
        durationSecs, billedSecs, costCents,
        providerCostCents: Math.round(costCents * 0.6),
        transcript: transcript ? JSON.stringify(transcript) : null,
        summary,
        webhookDelivered: Math.random() < 0.95,
        createdAt: startedAt,
        updatedAt: endedAt ?? startedAt,
      },
    });

    // Turns para chamadas completadas com transcript
    if (transcript) {
      for (const turn of transcript) {
        await db.callTurn.create({
          data: {
            callId: call.id, seq: turn.seq,
            role: turn.role === 'AGENT' ? 'AGENT' : 'HUMAN',
            text: turn.text,
            sttMs: turn.role === 'HUMAN' ? rand(200, 800) : null,
            llmMs: turn.role === 'AGENT' ? rand(300, 1200) : null,
            ttsMs: turn.role === 'AGENT' ? rand(500, 2000) : null,
            createdAt: addSeconds(startedAt, turn.seq * rand(8, 25)),
          },
        });
      }
    }

    return { call, costCents };
  }

  // ── Chamadas históricas (30 dias) ─────────────────────────────────────────
  console.log('📞 A criar chamadas históricas...');

  const callStats = { total: 0, totalCostCents: 0 };

  // Demo Company — 80 chamadas, agente de cobrança
  const demoContacts = tenantContacts[t1.id]!;
  for (let day = 29; day >= 0; day--) {
    const callsToday = day % 7 < 5 ? rand(2, 5) : rand(0, 1); // menos ao fim de semana
    for (let c = 0; c < callsToday; c++) {
      const contact = pick(demoContacts);
      const r = await createCall({
        tenantId: t1.id, agentId: 'agent_demo_cobranca',
        contact, daysBack: day, withTranscript: Math.random() < 0.3,
      });
      callStats.total++;
      callStats.totalCostCents += r.costCents;
    }
  }

  // BancaPlus — 250 chamadas
  const bancaContacts = tenantContacts[t2.id]!;
  for (let day = 29; day >= 0; day--) {
    const callsToday = day % 7 < 5 ? rand(6, 14) : rand(0, 2);
    for (let c = 0; c < callsToday; c++) {
      const contact = pick(bancaContacts);
      const agentId = Math.random() < 0.6 ? 'agent_banca_credito' : 'agent_banca_seguros';
      const r = await createCall({
        tenantId: t2.id, agentId, contact, daysBack: day,
        withTranscript: Math.random() < 0.4,
      });
      callStats.total++;
      callStats.totalCostCents += r.costCents;
    }
  }

  // Telecomunica — 120 chamadas
  const telecomContacts = tenantContacts[t3.id]!;
  for (let day = 29; day >= 0; day--) {
    const callsToday = day % 7 < 5 ? rand(3, 7) : rand(0, 1);
    for (let c = 0; c < callsToday; c++) {
      const contact = pick(telecomContacts);
      const r = await createCall({
        tenantId: t3.id, agentId: 'agent_telecom_renovacao',
        contact, daysBack: day, withTranscript: Math.random() < 0.25,
      });
      callStats.total++;
      callStats.totalCostCents += r.costCents;
    }
  }

  console.log(`✅ Chamadas: ${callStats.total} criadas (custo total: ${(callStats.totalCostCents / 100).toFixed(0)} Kz)`);

  // ── Campanhas ─────────────────────────────────────────────────────────────
  const campaigns = [
    {
      id: 'camp_demo_jan',
      tenantId: t1.id, agentId: 'agent_demo_satisfacao',
      name: 'Pesquisa Satisfação – Julho 2026',
      status: 'DONE' as CampaignStatus,
      contacts: demoContacts.slice(0, 40),
      completedPct: 0.85,
    },
    {
      id: 'camp_banca_credito_q3',
      tenantId: t2.id, agentId: 'agent_banca_credito',
      name: 'Campanha Crédito Q3 2026',
      status: 'RUNNING' as CampaignStatus,
      contacts: bancaContacts.slice(0, 100),
      completedPct: 0.45,
    },
    {
      id: 'camp_telecom_renovacao',
      tenantId: t3.id, agentId: 'agent_telecom_renovacao',
      name: 'Renovação Contratos Set/2026',
      status: 'SCHEDULED' as CampaignStatus,
      contacts: telecomContacts.slice(0, 60),
      completedPct: 0,
    },
  ];

  for (const camp of campaigns) {
    const completed = Math.floor(camp.contacts.length * camp.completedPct);
    await db.campaign.upsert({
      where: { id: camp.id },
      update: {},
      create: {
        id: camp.id,
        tenantId: camp.tenantId, agentId: camp.agentId,
        name: camp.name, status: camp.status,
        totalContacts: camp.contacts.length,
        completed, failedCount: Math.floor(completed * 0.18),
        throttlePerMinute: 3,
        scheduleJson: { timezone: 'Africa/Luanda', startHour: 9, endHour: 17, days: [1,2,3,4,5] },
        retryPolicy: { maxAttempts: 3, intervalMinutes: 60 },
        summary: camp.status === 'DONE'
          ? `Taxa de contacto: 87%. NPS médio: 7.4. ${completed} respostas recolhidas.`
          : null,
        createdAt: daysAgo(rand(10, 25)),
      },
    });

    // CampaignContacts
    for (let i = 0; i < camp.contacts.length; i++) {
      const contact = camp.contacts[i]!;
      let status: CampaignContactStatus = 'PENDING';
      if (i < completed) {
        status = Math.random() < 0.82 ? 'COMPLETED' : 'FAILED';
      } else if (camp.status === 'RUNNING' && i < completed + 10) {
        status = 'QUEUED';
      }
      await db.campaignContact.upsert({
        where: { campaignId_contactId: { campaignId: camp.id, contactId: contact.id } },
        update: {},
        create: {
          campaignId: camp.id, contactId: contact.id,
          status, attempts: status === 'PENDING' ? 0 : rand(1, 3),
          nextRetryAt: status === 'FAILED' ? daysAgo(-1) : null,
        },
      });
    }
    console.log(`✅ Campanha: ${camp.name} (${camp.contacts.length} contactos)`);
  }

  // ── Transacções de carteira ────────────────────────────────────────────────
  console.log('💰 A criar transacções de carteira...');

  async function createTxHistory(tenantId: string, monthlyFee: number, avgDailySpend: number) {
    let balance = 0;
    const txs: Array<{
      tenantId: string; type: TxType; amountCents: number;
      balanceAfterCents: number; note?: string; createdAt: Date;
    }> = [];

    // 2 carregamentos iniciais (há 60 e 30 dias)
    for (const daysBack of [60, 30]) {
      const topup = rand(5_000_000, 15_000_000);
      balance += topup;
      txs.push({ tenantId, type: 'TOPUP', amountCents: topup, balanceAfterCents: balance, note: 'Carregamento por transferência bancária', createdAt: daysAgo(daysBack, 10) });
    }

    // Taxa mensal há 30 dias
    balance -= monthlyFee;
    txs.push({ tenantId, type: 'MONTHLY_FEE', amountCents: -monthlyFee, balanceAfterCents: balance, note: 'Taxa mensal do plano', createdAt: daysAgo(30, 2) });

    // Cobranças diárias de chamadas (últimos 29 dias)
    for (let day = 29; day >= 1; day--) {
      if (day % 7 >= 5) continue; // sem cobranças ao fim de semana
      const daySpend = Math.round(avgDailySpend * (0.7 + Math.random() * 0.6));
      if (daySpend <= 0) continue;
      balance -= daySpend;
      txs.push({
        tenantId, type: 'CALL_CHARGE', amountCents: -daySpend,
        balanceAfterCents: balance,
        note: `Chamadas ${new Date(Date.now() - day * 86400000).toISOString().slice(0, 10)}`,
        createdAt: daysAgo(day, 23),
      });
    }

    // Taxa mensal actual
    balance -= monthlyFee;
    txs.push({ tenantId, type: 'MONTHLY_FEE', amountCents: -monthlyFee, balanceAfterCents: balance, note: 'Taxa mensal do plano', createdAt: daysAgo(0, 2) });

    for (const tx of txs) {
      await db.walletTransaction.create({ data: tx });
    }

    return balance;
  }

  const finalBalance1 = await createTxHistory(t1.id, 500_000, 120_000);
  const finalBalance2 = await createTxHistory(t2.id, 1_500_000, 800_000);
  const finalBalance3 = await createTxHistory(t3.id, 500_000, 350_000);

  // Actualizar saldos
  await db.tenant.update({ where: { id: t1.id }, data: { balanceCents: Math.max(0, finalBalance1) } });
  await db.tenant.update({ where: { id: t2.id }, data: { balanceCents: Math.max(0, finalBalance2) } });
  await db.tenant.update({ where: { id: t3.id }, data: { balanceCents: Math.max(0, finalBalance3) } });

  console.log('✅ Transacções de carteira criadas');

  // ── SystemSettings ────────────────────────────────────────────────────────
  await db.systemSetting.upsert({
    where: { key: 'MAX_CONCURRENT_CALLS' },
    update: {}, create: { key: 'MAX_CONCURRENT_CALLS', value: '50', isSecret: false },
  });
  await db.systemSetting.upsert({
    where: { key: 'DEFAULT_PLAN_ID' },
    update: {}, create: { key: 'DEFAULT_PLAN_ID', value: planStarter.id, isSecret: false },
  });

  // ── Resumo ────────────────────────────────────────────────────────────────
  const totalCalls = await db.call.count();
  const totalContacts = await db.contact.count();
  const totalTx = await db.walletTransaction.count();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉 Seed de demonstração concluído!\n');
  console.log(`  📊 ${totalCalls} chamadas  |  ${totalContacts} contactos  |  ${totalTx} transacções`);
  console.log('\n  Acessos:');
  console.log('  Backoffice  → http://localhost:5174  |  admin@comunica.ao / admin123');
  console.log('  CRM Demo    → http://localhost:5173  |  demo@demo.com / demo123');
  console.log('  CRM Banca   → http://localhost:5173  |  ops@bancaplus.ao / banca123');
  console.log('  CRM Telecom → http://localhost:5173  |  suporte@telecom.ao / telecom123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
