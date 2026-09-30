import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { logger } from '../../src/lib/logger';
import { prisma } from '../../src/lib/prisma';
import { emailQueue } from '../../src/queues/email.queue';
import { searchService } from '../../src/services/elasticsearch.service';
import { reconcileScheduledEmails } from '../../src/services/reconciliation.service';
import { scheduleEmails } from '../../src/services/scheduler.service';
import { emailJobId } from '../../src/types/queue';
import { createUser, resetState } from '../helpers';

const reconcile = () =>
  reconcileScheduledEmails({ prisma, queue: emailQueue, search: searchService, logger, sendingStaleMs: env.SENDING_STALE_MS });

async function scheduleFuture(userId: string, count: number) {
  return scheduleEmails(userId, {
    subject: 'Future campaign',
    body: '<p>Later</p>',
    recipients: Array.from({ length: count }, (_, i) => `lead${i}@example.com`),
    startTime: new Date(Date.now() + 2 * 3_600_000),
    delayBetweenEmailsMs: 2000,
    hourlyLimit: 200,
    idempotencyKey: `recovery-${Math.random().toString(36).slice(2)}`,
  });
}

describe('startup reconciliation', () => {
  beforeEach(resetState);

  it('recreates missing BullMQ jobs from PostgreSQL, keeping the stored schedule', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleFuture(user.id, 5);
    const lost = emailIds.slice(0, 2);
    for (const id of lost) await (await emailQueue.getJob(emailJobId(id)))?.remove();
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(3);

    const report = await reconcile();
    expect(report).toMatchObject({ checked: 5, existing: 3, recreated: 2, repaired: 0 });
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(5);

    for (const id of lost) {
      const job = await emailQueue.getJob(emailJobId(id));
      const row = await prisma.email.findUniqueOrThrow({ where: { id } });
      expect(await job?.getState()).toBe('delayed');
      // Not restarted from scratch: fires at the originally persisted time.
      expect(Math.abs((job?.timestamp ?? 0) + (job?.delay ?? 0) - row.scheduledAt.getTime())).toBeLessThan(2_000);
    }
  });

  it('does not duplicate existing jobs and is idempotent', async () => {
    const { user } = await createUser();
    await scheduleFuture(user.id, 10);
    const first = await reconcile();
    const second = await reconcile();
    expect(first).toMatchObject({ checked: 10, existing: 10, recreated: 0 });
    expect(second).toMatchObject({ checked: 10, existing: 10, recreated: 0 });
    expect((await emailQueue.getJobCounts('delayed', 'waiting')).delayed).toBe(10);
  });

  it('never re-enqueues an already-sent email', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleFuture(user.id, 2);
    const sentId = emailIds[0] as string;
    await prisma.email.update({ where: { id: sentId }, data: { status: 'SENT', sentAt: new Date() } });
    await (await emailQueue.getJob(emailJobId(sentId)))?.remove();

    const report = await reconcile();
    expect(report).toMatchObject({ checked: 1, recreated: 0 });
    expect(await emailQueue.getJob(emailJobId(sentId))).toBeUndefined();
  });

  it('marks stale SENDING rows FAILED instead of resending them', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleFuture(user.id, 1);
    const id = emailIds[0] as string;
    await prisma.email.update({
      where: { id },
      data: { status: 'SENDING', sendStartedAt: new Date(Date.now() - env.SENDING_STALE_MS - 1000) },
    });

    const report = await reconcile();
    expect(report.staleSendingFailed).toBe(1);
    const row = await prisma.email.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.errorMessage).toMatch(/outcome unknown/i);
  });

  it('handles a 1000-email campaign: one job each, all recoverable', async () => {
    const { user } = await createUser();
    const res = await scheduleFuture(user.id, 1000);
    expect(res.emailIds).toHaveLength(1000);
    expect(await prisma.email.count()).toBe(1000);
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(1000);

    // Simulate losing the whole Redis queue (e.g. no persistence) and restarting.
    await emailQueue.obliterate({ force: true });
    const report = await reconcile();
    expect(report).toMatchObject({ checked: 1000, recreated: 1000 });
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(1000);
  });
});
