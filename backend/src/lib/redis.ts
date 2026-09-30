import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * BullMQ needs `maxRetriesPerRequest: null` on connections used by workers
 * (blocking commands). We use the same options everywhere for simplicity.
 */
export const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

export function createRedis(name: string): Redis {
  const client = new Redis(env.REDIS_URL, { ...redisOptions, connectionName: `reachinbox:${name}` });
  client.on('error', (err) => logger.error({ err: err.message, connection: name }, 'redis connection error'));
  return client;
}

/** Shared general-purpose connection: rate limiter, sessions, Slack dedupe, OAuth state. */
export const redis = createRedis('shared');
