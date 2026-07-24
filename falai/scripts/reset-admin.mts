import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const hash = await argon2.hash('admin123', { type: argon2.argon2id });
await prisma.adminUser.update({ where: { email: 'admin@comunica.ao' }, data: { passwordHash: hash } });
console.log('Password reposta: admin123');
await prisma.$disconnect();
