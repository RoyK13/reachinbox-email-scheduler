/**
 * Rebuilds the Elasticsearch index from PostgreSQL (the source of truth).
 *
 *   npm run reindex               # upsert every email into the existing index
 *   npm run reindex -- --recreate # drop + recreate the index with fresh mappings first
 */
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { searchService } from '../services/elasticsearch.service';
import { errorMessage } from '../utils/errors';

const BATCH = 1_000;

async function main(): Promise<void> {
  const recreate = process.argv.includes('--recreate');
  if (recreate) {
    await searchService.deleteIndex();
    logger.info({ index: searchService.index }, 'index dropped');
  }
  await searchService.ensureIndex();

  let cursor: string | undefined;
  let indexed = 0;
  let failed = 0;
  for (;;) {
    const batch = await prisma.email.findMany({
      include: { sender: { select: { email: true } } },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    failed += await searchService.indexEmails(batch);
    indexed += batch.length;
    cursor = batch[batch.length - 1]?.id;
    logger.info({ indexed }, 'reindex progress');
  }
  await searchService.refresh();
  logger.info({ indexed, failed, index: searchService.index }, 'reindex complete');
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    logger.error({ err: errorMessage(err) }, 'reindex failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
