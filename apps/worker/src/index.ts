import { describeEnvWarnings, loadDotenv, loadEnv } from '@repeat/config';
import { createCoreServices, createLogger, createStorageProvider } from '@repeat/core';
import { createPrismaClient } from '@repeat/database';
import { createProviders } from '@repeat/providers';
import {
  BullMqPublishDispatcher,
  createPublishQueue,
  createPublishWorker,
  createRedisConnection,
} from '@repeat/queue';

/**
 * Background worker: consumes publish jobs and runs them through the core
 * PublishingEngine. Scale horizontally by running more instances.
 */
async function main(): Promise<void> {
  loadDotenv();
  const env = loadEnv();
  const logger = createLogger({
    level: env.LOG_LEVEL,
    name: 'repeat-worker',
    pretty: env.NODE_ENV === 'development',
  });
  for (const warning of describeEnvWarnings(env)) logger.warn(warning);

  const db = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const connection = createRedisConnection(env.REDIS_URL);
  const queue = createPublishQueue(connection);
  const { providers, connectors, unconfigured } = createProviders(env);
  const services = createCoreServices({
    env,
    db,
    logger,
    storage: createStorageProvider(env),
    providers,
    connectors,
    dispatcher: new BullMqPublishDispatcher(queue),
  });

  const worker = createPublishWorker({
    connection,
    engine: services.engine,
    logger,
    concurrency: env.WORKER_CONCURRENCY,
  });

  logger.info(
    {
      providers: providers.list().map((provider) => provider.platform),
      unconfigured: unconfigured.map((entry) => entry.platform),
      concurrency: env.WORKER_CONCURRENCY,
    },
    'worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    try {
      await worker.close();
      await queue.close();
      await connection.quit();
      await db.$disconnect();
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
