import { Redis } from 'ioredis';
import { config } from '../../config/env.js';
import { logger } from '../logger/logger.js';

/**
 * Creates a Redis connection. BullMQ requires `maxRetriesPerRequest: null` on connections
 * used by workers and queues; general-purpose connections (rate limiting, health) use a small
 * retry budget so commands fail within a second or two when Redis is unavailable.
 */
export function createRedisConnection(purpose: 'queue' | 'worker' | 'general'): Redis {
  if (!config.redisUrl) throw new Error('REDIS_URL is not configured');
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: purpose === 'general' ? 2 : null,
    connectTimeout: 5_000,
  });
  connection.on('error', (error) => {
    logger.warn({ err: error, purpose }, 'Redis connection error');
  });
  return connection;
}

let generalConnection: Redis | null = null;

export function getGeneralRedis(): Redis {
  generalConnection ??= createRedisConnection('general');
  return generalConnection;
}

export async function closeGeneralRedis(): Promise<void> {
  if (generalConnection) {
    await generalConnection.quit().catch(() => undefined);
    generalConnection = null;
  }
}
