import 'server-only';
import { OAuthFlowService, SessionService, UserService } from '@repeat/auth';
import { describeEnvWarnings, loadDotenv, loadEnv, type Env } from '@repeat/config';
import {
  createCoreServices,
  createLogger,
  createStorageProvider,
  type CoreServices,
  type Logger,
} from '@repeat/core';
import { createPrismaClient, type Db } from '@repeat/database';
import { createProviders, type ProviderSetup } from '@repeat/providers';
import { BullMqPublishDispatcher, createPublishQueue, createRedisConnection } from '@repeat/queue';

export interface Container {
  env: Env;
  db: Db;
  logger: Logger;
  services: CoreServices;
  providerSetup: ProviderSetup;
  sessions: SessionService;
  users: UserService;
  oauth: OAuthFlowService;
}

declare global {
  var __repeatContainer: Container | undefined;
}

/**
 * Composition root for the web process. Built once per process and cached on
 * globalThis so Next.js hot reloading does not open a new database/Redis
 * connection on every change.
 */
export function getContainer(): Container {
  if (globalThis.__repeatContainer) return globalThis.__repeatContainer;

  loadDotenv();
  const env = loadEnv();
  // No pretty transport here: pino's worker-thread transport does not survive Next.js hot reloads.
  const logger = createLogger({ level: env.LOG_LEVEL, name: 'repeat-web' });
  for (const warning of describeEnvWarnings(env)) logger.warn(warning);
  const db = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const queue = createPublishQueue(createRedisConnection(env.REDIS_URL));
  const providerSetup = createProviders(env);
  const services = createCoreServices({
    env,
    db,
    logger,
    storage: createStorageProvider(env),
    providers: providerSetup.providers,
    connectors: providerSetup.connectors,
    dispatcher: new BullMqPublishDispatcher(queue),
  });
  const sessions = new SessionService(db);
  const users = new UserService({ db, allowRegistration: env.ALLOW_REGISTRATION });
  const oauth = new OAuthFlowService({
    db,
    connectors: providerSetup.connectors,
    accounts: services.accounts,
    cipher: services.cipher,
    logger,
    appUrl: env.APP_URL,
  });

  logger.info(
    {
      providers: providerSetup.providers.list().map((p) => p.platform),
      unconfigured: providerSetup.unconfigured.map((u) => u.platform),
    },
    'web container initialized',
  );

  const container: Container = { env, db, logger, services, providerSetup, sessions, users, oauth };
  globalThis.__repeatContainer = container;
  return container;
}
