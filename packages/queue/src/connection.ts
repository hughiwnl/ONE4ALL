import IORedis from 'ioredis';

/** BullMQ requires `maxRetriesPerRequest: null` on its blocking connections. */
export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}
