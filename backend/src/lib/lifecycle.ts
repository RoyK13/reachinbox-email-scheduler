import { logger } from './logger';
import { prisma } from './prisma';
import { redis } from './redis';
import { searchService } from '../services/elasticsearch.service';
import { errorMessage } from '../utils/errors';

/** Connect PostgreSQL → Redis → Elasticsearch (and create the index). Fails fast. */
export async function connectInfrastructure(): Promise<void> {
  await prisma.$connect();
  logger.info('postgres connected');

  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('redis is not reachable (timed out after 15s)')), 15_000);
      redis.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const policy = (await redis.config('GET', 'maxmemory-policy')) as string[];
  if (policy[1] && policy[1] !== 'noeviction') {
    logger.warn({ policy: policy[1] }, 'redis maxmemory-policy should be "noeviction" for BullMQ');
  }
  logger.info('redis connected');

  if (!(await searchService.ping())) throw new Error('elasticsearch is not reachable');
  await searchService.ensureIndex();
  logger.info({ index: searchService.index }, 'elasticsearch ready');
}

export type Closer = { name: string; close: () => Promise<unknown> | unknown };

/** SIGINT/SIGTERM → close resources in order, then exit. */
export function onShutdown(closers: Closer[]): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    for (const c of closers) {
      try {
        await c.close();
      } catch (err) {
        logger.warn({ resource: c.name, err: errorMessage(err) }, 'error during shutdown');
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
