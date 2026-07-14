import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

const db = new PrismaClient();

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

async function main() {
  console.log('Seeding Falaí dev database...\n');

  // ── Planos ────────────────────────────────────────────────────
  const plan = await db.plan.upsert({
    where: { id: 'plan_starter' },
    update: {},
    create: {
      id: 'plan_starter',
      name: 'Starter',
      pricePerMinuteCents: 150,    // 1,50 Kz/min
      pricePerCallCents: 0,
      monthlyFeeCents: 500000,     // 5 000 Kz/mês
      maxAgents: 5,
      maxConcurrent: 3,
      sttMarginPct: 20,
      isActive: true,
    },
  });
  console.log(`✅ Plano: ${plan.name}`);

  const planPro = await db.plan.upsert({
    where: { id: 'plan_pro' },
    update: {},
    create: {
      id: 'plan_pro',
      name: 'Pro',
      pricePerMinuteCents: 100,    // 1,00 Kz/min
      pricePerCallCents: 0,
      monthlyFeeCents: 1500000,    // 15 000 Kz/mês
      maxAgents: 20,
      maxConcurrent: 10,
      sttMarginPct: 20,
      isActive: true,
    },
  });
  console.log(`✅ Plano: ${planPro.name}`);

  // ── Admin SUPERADMIN ──────────────────────────────────────────
  const admin = await db.adminUser.upsert({
    where: { email: 'admin@comunica.ao' },
    update: { passwordHash: await hashPassword('admin123') },
    create: {
      email: 'admin@comunica.ao',
      name: 'Super Admin',
      passwordHash: await hashPassword('admin123'),
      role: 'SUPERADMIN',
    },
  });
  console.log(`✅ Admin: ${admin.email}  →  password: admin123`);

  // ── Tenant de demo ────────────────────────────────────────────
  const tenant = await db.tenant.upsert({
    where: { id: 'tenant_demo' },
    update: {},
    create: {
      id: 'tenant_demo',
      name: 'Demo Company',
      email: 'demo@demo.com',
      phone: '+244923000000',
      planId: plan.id,
      status: 'ACTIVE',
      balanceCents: 5000000,       // 50 000 Kz
      creditLimitCents: 0,
      maxConcurrent: 3,
      webhookSecret: randomBytes(16).toString('hex'),
    },
  });
  console.log(`✅ Tenant: ${tenant.name} (ID: ${tenant.id})`);

  // ── Owner do tenant ───────────────────────────────────────────
  const tenantUser = await db.tenantUser.upsert({
    where: { email: 'demo@demo.com' },
    update: { passwordHash: await hashPassword('demo123') },
    create: {
      email: 'demo@demo.com',
      name: 'Demo User',
      passwordHash: await hashPassword('demo123'),
      role: 'OWNER',
      tenantId: tenant.id,
    },
  });
  console.log(`✅ Tenant user: ${tenantUser.email}  →  password: demo123`);

  // ── Configurações de sistema ──────────────────────────────────
  await db.systemSetting.upsert({
    where: { key: 'MAX_CONCURRENT_CALLS' },
    update: {},
    create: { key: 'MAX_CONCURRENT_CALLS', value: '50', isSecret: false },
  });
  await db.systemSetting.upsert({
    where: { key: 'DEFAULT_PLAN_ID' },
    update: {},
    create: { key: 'DEFAULT_PLAN_ID', value: plan.id, isSecret: false },
  });
  console.log('✅ SystemSettings criados');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉 Seed concluído!\n');
  console.log('  Backoffice → http://localhost:5174');
  console.log('              admin@comunica.ao / admin123\n');
  console.log('  CRM        → http://localhost:5173');
  console.log('              demo@demo.com / demo123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
