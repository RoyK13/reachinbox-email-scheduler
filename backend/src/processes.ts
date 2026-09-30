import { createApp } from './app';
import { env } from './config/env';
import { connectInfrastructure, onShutdown, type Closer } from './lib/lifecycle';
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

/** HTTP API. Returns the resources it owns so the caller can close them. */
export function startApi(): Closer[] {
  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, frontend: env.FRONTEND_URL }, 'API listening');
  });
  return [{ name: 'http', close: () => new Promise((resolve) => server.close(resolve)) }];
}

/**
 * BullMQ worker: start consuming, then reconcile SCHEDULED rows against their
 * deterministic job ids (one-time startup recovery, not a recurring task).
 */
export async function startWorker(): Promise<Closer[]> {
  const worker = createEmailWorker();
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

  return [
    { name: 'worker', close: () => worker.close() },
    { name: 'mail', close: () => mailService.closeAll() },
  ];
}

const sharedClosers: Closer[] = [
  { name: 'queue', close: () => emailQueue.close() },
  { name: 'redis', close: () => redis.quit() },
  { name: 'prisma', close: () => prisma.$disconnect() },
];

/**
 * Boot sequence shared by every entry point:
 *   PostgreSQL → Redis → Elasticsearch (+ index) → sender sync → roles → ready
 * Roles are closed in reverse start order on SIGINT/SIGTERM, then shared clients.
 */
export async function run(roles: { api: boolean; worker: boolean }): Promise<void> {
  try {
    await connectInfrastructure();
    await syncSendersForAllUsers();
    const closers: Closer[] = [];
    if (roles.api) closers.push(...startApi());
    if (roles.worker) closers.unshift(...(await startWorker()));
    onShutdown([...closers, ...sharedClosers]);
  } catch (err) {
    logger.fatal({ err: errorMessage(err), roles }, 'failed to start');
    process.exit(1);
  }
}
