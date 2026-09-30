import type { Queue } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../lib/logger';
import { SEND_EMAIL_JOB, emailJobId, type EmailJobData } from '../types/queue';
import { errorMessage } from '../utils/errors';
import type { ElasticsearchService } from './elasticsearch.service';

export interface ReconciliationDeps {
  prisma: PrismaClient;
  queue: Queue<EmailJobData, void, typeof SEND_EMAIL_JOB>;
  search: ElasticsearchService;
  logger: Logger;
  sendingStaleMs: number;
}

export interface ReconciliationReport {
  checked: number;
  existing: number;
  recreated: number;
  repaired: number;
  staleSendingFailed: number;
}

const BATCH = 500;
const LOOKUP_CONCURRENCY = 50;
/** Job states that mean "BullMQ will still run this job". */
const LIVE_STATES = new Set(['delayed', 'waiting', 'waiting-children', 'prioritized', 'active']);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}

/**
 * Startup recovery (runs once when a worker boots — not a recurring scheduler).
 *
 * PostgreSQL is the source of truth. For every SCHEDULED email we check its
 * deterministic BullMQ job ("email-<id>"):
 *   - live (delayed/waiting/active) → untouched (no duplicates, no reset)
 *   - missing                      → re-added with delay = scheduledAt − now
 *   - completed/failed but DB still SCHEDULED → stale entry removed, re-added
 * SENT / FAILED rows are never enqueued. Running it twice is a no-op.
 */
export async function reconcileScheduledEmails(deps: ReconciliationDeps): Promise<ReconciliationReport> {
  const { prisma, queue, logger } = deps;
  const report: ReconciliationReport = { checked: 0, existing: 0, recreated: 0, repaired: 0, staleSendingFailed: 0 };

  report.staleSendingFailed = await failStaleSending(deps);

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.email.findMany({
      where: { status: 'SCHEDULED' },
      select: { id: true, scheduledAt: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]?.id;
    report.checked += batch.length;

    const toAdd: Array<{ id: string; scheduledAt: Date }> = [];
    await mapLimit(batch, LOOKUP_CONCURRENCY, async (email) => {
      const job = await queue.getJob(emailJobId(email.id));
      if (!job) {
        toAdd.push(email);
        report.recreated++;
        return;
      }
      const state = await job.getState();
      if (LIVE_STATES.has(state)) {
        report.existing++;
        return;
      }
      // Finished job but the DB never reached SENT/FAILED (e.g. crash between steps).
      try {
        await job.remove();
        toAdd.push(email);
        report.repaired++;
      } catch (err) {
        logger.warn({ emailId: email.id, state, err: errorMessage(err) }, 'could not remove stale job');
      }
    });

    if (toAdd.length > 0) {
      const now = Date.now();
      await queue.addBulk(
        toAdd.map((email) => ({
          name: SEND_EMAIL_JOB,
          data: { emailId: email.id },
          opts: { jobId: emailJobId(email.id), delay: Math.max(0, email.scheduledAt.getTime() - now) },
        })),
      );
    }
    if (batch.length < BATCH) break;
  }

  logger.info(report, 'startup reconciliation completed');
  return report;
}

/**
 * An email stuck in SENDING means a worker died mid-send. The SMTP server may
 * or may not have accepted it, so it is NOT retried (that could duplicate
 * delivery); it is marked FAILED with an explicit "outcome unknown" reason.
 */
async function failStaleSending(deps: ReconciliationDeps): Promise<number> {
  const cutoff = new Date(Date.now() - deps.sendingStaleMs);
  const stale = await deps.prisma.email.findMany({
    where: { status: 'SENDING', sendStartedAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return 0;

  const ids = stale.map((s) => s.id);
  const { count } = await deps.prisma.email.updateMany({
    where: { id: { in: ids }, status: 'SENDING' },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      errorMessage: 'Send outcome unknown: worker stopped after SMTP handoff began. Not retried to avoid duplicate delivery.',
    },
  });
  const rows = await deps.prisma.email.findMany({
    where: { id: { in: ids } },
    include: { sender: { select: { email: true } } },
  });
  await deps.search.indexEmails(rows);
  deps.logger.warn({ count }, 'stale SENDING emails marked FAILED (outcome unknown)');
  return count;
}
