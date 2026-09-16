/**
 * Helpers for integration tests that need a real PostgreSQL database.
 *
 * TEST_DATABASE_URL defaults to a `repeat_test` database on the same server
 * as the docker-compose `db` service. The database is (re)created and migrated
 * once per test run; individual tests truncate tables between cases.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://repeat:repeat@localhost:5432/repeat_test';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** vitest globalSetup: create the test database if needed and apply migrations. */
export async function setupTestDatabase(): Promise<void> {
  await ensureDatabaseExists(TEST_DATABASE_URL);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}

async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, '');
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error(`Unsafe test database name: ${name}`);
  const maintenance = new URL(databaseUrl);
  maintenance.pathname = '/postgres';
  const admin = new PrismaClient({
    datasources: { db: { url: maintenance.toString() } },
    log: ['error'],
  });
  try {
    const rows = await admin.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = '${name}') AS "exists"`,
    );
    if (!rows[0]?.exists) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }
}

export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } }, log: ['error'] });
}

/** Remove every row from every application table (order-independent thanks to CASCADE). */
export async function truncateAll(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "post_destinations", "posts", "media", "pending_connections", "oauth_states", "social_accounts", "sessions", "users" CASCADE',
  );
}
