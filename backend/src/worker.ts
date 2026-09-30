import { env } from './config/env';
import { connectInfrastructure, onShutdown } from './lib/lifecycle';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { emailQueue } from './queues/email.queue';
import { deleteOrphanAttachments } from './services/attachment.service';
import { searchService } from './services/elasticsearch.service';
import { reconcileScheduledEmails } from './services/reconciliation.service';
import { syncSendersForAllUsers } from './services/sender.service';
import { errorMessage } from './utils/errors';
import { createEmailWorker, mailService } from './workers/email.worker';

/**
 * Worker process boot sequence:
 *   PostgreSQL → Redis → Elasticsearch (+ index) → start BullMQ worker
 *   → reconcile SCHEDULED rows against deterministic job ids → ready
 */
async function main(): Promise<void> {
  await connectInfrastructure();
  await syncSendersForAllUsers();

  const worker = createEmailWorker();
  onShutdown([
    { name: 'worker', close: () => worker.close() },
    { name: 'queue', close: () => emailQueue.close() },
    { name: 'mail', close: () => mailService.closeAll() },
    { name: 'redis', close: () => redis.quit() },
    { name: 'prisma', close: () => prisma.$disconnect() },
  ]);

  void worker.run();
  await worker.waitUntilReady();
  logger.info({ queue: emailQueue.name, concurrency: env.WORKER_CONCURRENCY }, 'email worker started');

  await reconcileScheduledEmails({
    prisma,
    queue: emailQueue,
    search: searchService,
    logger,
    sendingStaleMs: env.SENDING_STALE_MS,
  });
  await deleteOrphanAttachments();
  logger.info('worker ready');
}

main().catch((err) => {
  logger.fatal({ err: errorMessage(err) }, 'worker failed to start');
  process.exit(1);
});
