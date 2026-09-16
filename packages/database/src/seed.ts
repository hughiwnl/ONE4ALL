/**
 * Development seed: creates a local user so you can log in immediately.
 *
 *   email:    dev@repeat.local
 *   password: repeat-dev-password
 *
 * Safe to run repeatedly. Never run against a production database.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Mirrors @repeat/auth hashPassword (kept inline so the seed has no workspace deps).
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function main() {
  const email = 'dev@repeat.local';
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Dev User', passwordHash: hashPassword('repeat-dev-password') },
  });
  console.log(`Seeded user ${user.email} (id ${user.id}). Password: repeat-dev-password`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
