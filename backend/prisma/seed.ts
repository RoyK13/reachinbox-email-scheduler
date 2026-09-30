/**
 * Idempotent seed:
 *   - validates ETHEREAL_SENDERS_JSON (via config) and (re)provisions senders
 *     for every existing user — users themselves only come from Google login,
 *   - creates the Elasticsearch index with its mappings.
 *
 * Safe to run any number of times.
 */
import { env } from '../src/config/env';
import { logger } from '../src/lib/logger';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { searchService } from '../src/services/elasticsearch.service';
import { syncSendersForAllUsers } from '../src/services/sender.service';

async function main(): Promise<void> {
  await searchService.ensureIndex();
  await syncSendersForAllUsers();
  logger.info(
    { configuredSenders: env.ETHEREAL_SENDERS_JSON.map((s) => s.email), index: searchService.index },
    'seed complete (senders are provisioned per user at Google login)',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
