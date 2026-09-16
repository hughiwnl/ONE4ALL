import { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;

export interface CreatePrismaClientOptions {
  databaseUrl: string;
  /** Log SQL queries (development only; never enable where secrets could be logged). */
  logQueries?: boolean;
}

/**
 * Create a Prisma client for the given connection string.
 *
 * Processes create exactly one client and pass it down explicitly (dependency
 * injection) instead of importing a global singleton. This keeps the core
 * services testable against a dedicated test database.
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}
