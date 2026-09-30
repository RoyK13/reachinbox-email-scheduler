import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { searchService } from '../services/elasticsearch.service';

type ServiceState = 'ok' | 'down';

async function check(fn: () => Promise<unknown>): Promise<ServiceState> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
    ]);
    return result === false ? 'down' : 'ok';
  } catch {
    return 'down';
  }
}

export async function health(_req: Request, res: Response): Promise<void> {
  const [database, redisState, elasticsearch] = await Promise.all([
    check(() => prisma.$queryRaw`SELECT 1`),
    check(() => redis.ping()),
    check(() => searchService.ping()),
  ]);
  const services = { database, redis: redisState, elasticsearch };
  const healthy = Object.values(services).every((s) => s === 'ok');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', services });
}
