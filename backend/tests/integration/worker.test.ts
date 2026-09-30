import { Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto';
import { prisma } from '../../src/lib/prisma';
import { createRedis, redis } from '../../src/lib/redis';
import { EMAIL_QUEUE_NAME, emailQueue, enqueueEmails } from '../../src/queues/email.queue';
import { searchService } from '../../src/services/elasticsearch.service';
import { scheduleEmails } from '../../src/services/scheduler.service';
import { SlackService } from '../../src/services/slack.service';
import { emailJobId, type EmailJobData } from '../../src/types/queue';
import { hourIndex, HOUR_MS } from '../../src/utils/time';
import { buildProcessor, createUser, fakeJob, resetState, slackMock, StubTransport, waitFor } from '../helpers';

let worker: Worker<EmailJobData> | null = null;

afterEach(async () => {
  await worker?.close();
  worker = null;
});

async function scheduleNow(userId: string, overrides: Partial<Parameters<typeof scheduleEmails>[1]> = {}) {
  return scheduleEmails(userId, {
    subject: 'Launch update',
    body: '<p>Big news</p>',
    recipients: ['one@example.com', 'two@example.com', 'three@example.com'],
    startTime: new Date(),
    delayBetweenEmailsMs: 2000,
    hourlyLimit: 100,
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
}

describe('worker: rate-limit rescheduling', () => {
  beforeEach(resetState);

  it('delays rate-limited jobs into the next hour instead of failing them, and alerts Slack once', async () => {
    const { user, senders } = await createUser();
    await prisma.slackConnection.create({
      data: { userId: user.id, teamId: 'T1', slackUserId: 'U1', accessTokenEnc: encryptSecret('xoxb-test') },
    });
    const slack = slackMock();
    const transport = new StubTransport();
    const { processor } = buildProcessor({ transport, slack: new SlackService(redis, slack.factory) });

    // Hourly limit 1 on a single sender: email #0 sends, #1 and #2 roll into later windows.
    const result = await scheduleNow(user.id, { hourlyLimit: 1, senderIds: [senders[0]?.id as string] });
    worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processor, { connection: createRedis('test-worker'), concurrency: 5 });

    const [first, second, third] = result.emailIds as [string, string, string];
    await waitFor(async () => (await prisma.email.findUnique({ where: { id: first } }))?.status === 'SENT');
    await waitFor(async () => {
      const states = await Promise.all([second, third].map(async (id) => (await emailQueue.getJob(emailJobId(id)))?.getState()));
      const moved = await Promise.all(
        [second, third].map(async (id) => (await emailQueue.getJob(emailJobId(id)))?.data.reservedSlotAt),
      );
      return states.every((s) => s === 'delayed') && moved.every((m) => m !== undefined);
    });

    const thisHour = hourIndex(Date.now());
    const rows = await prisma.email.findMany({ where: { id: { in: [second, third] } }, orderBy: { sequenceNumber: 'asc' } });
    // Next available windows, in sequence order.
    expect(rows.map((r) => r.scheduledAt.getTime())).toEqual([(thisHour + 1) * HOUR_MS, (thisHour + 2) * HOUR_MS]);
    expect(rows.every((r) => r.status === 'SCHEDULED')).toBe(true);

    for (const id of [second, third]) {
      const job = await emailQueue.getJob(emailJobId(id));
      expect(job?.attemptsMade).toBe(0);
      expect(job?.data.reservedSlotAt).toBe(rows.find((r) => r.id === id)?.scheduledAt.getTime());
    }
    expect((await emailQueue.getJobCounts('failed')).failed).toBe(0);
    expect(transport.sent).toHaveLength(1);

    // Slack: exactly one alert for this sender/hour, sent with the decrypted bot token.
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted[0]?.text).toContain('ReachInbox rate limit reached.');
    expect(slack.posted[0]?.text).toContain(senders[0]?.email);
    expect(slack.tokens).toContain('xoxb-test');
  });

  it('keeps processing (no crash) when Slack is not connected', async () => {
    const { user, senders } = await createUser();
    const { processor } = buildProcessor();
    const result = await scheduleNow(user.id, { hourlyLimit: 1, senderIds: [senders[0]?.id as string] });
    worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processor, { connection: createRedis('test-worker'), concurrency: 5 });

    await waitFor(async () => (await prisma.email.count({ where: { status: 'SENT' } })) === 1);
    await waitFor(async () => (await emailQueue.getJobCounts('delayed')).delayed === 2);
    expect((await emailQueue.getJobCounts('failed')).failed).toBe(0);
    expect(result.emailIds).toHaveLength(3);
  });
});

describe('worker: duplicate-send protection', () => {
  beforeEach(resetState);

  it('two workers processing the same email → exactly one SMTP send', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleNow(user.id, { recipients: ['solo@example.com'] });
    const id = emailIds[0] as string;
    const transport = new StubTransport();
    const a = buildProcessor({ transport });
    const b = buildProcessor({ transport });

    const now = Date.now();
    const outcomes = await Promise.all([
      a.processor(fakeJob({ emailId: id, reservedSlotAt: now })),
      b.processor(fakeJob({ emailId: id, reservedSlotAt: now })),
    ]);

    expect(transport.sent).toHaveLength(1);
    expect(outcomes.map((o) => o.result).sort()).toEqual(['sent', 'skipped']);
    expect((await prisma.email.findUniqueOrThrow({ where: { id } })).status).toBe('SENT');
  });

  it('sends as the user (From/Reply-To) through the assigned sender account (Sender/envelope)', async () => {
    const { user, senders } = await createUser('Ada Lovelace');
    const { emailIds } = await scheduleNow(user.id, { recipients: ['solo@example.com'] });
    const transport = new StubTransport();
    const { processor } = buildProcessor({ transport });

    await processor(fakeJob({ emailId: emailIds[0] as string, reservedSlotAt: Date.now() }));
    const via = senders[0]?.email as string;
    expect(transport.sent[0]).toMatchObject({
      from: { name: 'Ada Lovelace', address: user.email },
      replyTo: { name: 'Ada Lovelace', address: user.email },
      sender: { address: via },
      envelope: { from: via, to: 'solo@example.com' },
    });
  });

  it('a redelivered job for an already-sent email is a no-op', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleNow(user.id, { recipients: ['solo@example.com'] });
    const id = emailIds[0] as string;
    const transport = new StubTransport();
    const { processor } = buildProcessor({ transport });

    await processor(fakeJob({ emailId: id, reservedSlotAt: Date.now() }));
    const again = await processor(fakeJob({ emailId: id }));
    expect(again).toEqual({ result: 'skipped', reason: 'status_sent' });
    expect(transport.sent).toHaveLength(1);
  });

  it('enqueueing the same email twice creates a single BullMQ job', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleNow(user.id, {
      recipients: ['solo@example.com'],
      startTime: new Date(Date.now() + 3_600_000),
    });
    const id = emailIds[0] as string;
    const scheduledAt = new Date(Date.now() + 3_600_000);
    await enqueueEmails([{ emailId: id, scheduledAt }]);
    await enqueueEmails([{ emailId: id, scheduledAt }]);
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(1);
  });
});

describe('worker: SMTP failure handling', () => {
  beforeEach(resetState);

  it('returns the email to SCHEDULED for a retry when the failure was pre-acceptance', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleNow(user.id, { recipients: ['solo@example.com'] });
    const id = emailIds[0] as string;
    const transport = new StubTransport();
    transport.failWith = Object.assign(new Error('connect refused'), { code: 'ECONNECTION', command: 'CONN' });
    const { processor } = buildProcessor({ transport });

    await expect(processor(fakeJob({ emailId: id, reservedSlotAt: Date.now() }))).rejects.toThrow('connect refused');
    const row = await prisma.email.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SCHEDULED');
    expect(row.attemptCount).toBe(1);
  });

  it('marks the email FAILED and never retries an ambiguous (post-DATA) failure', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleNow(user.id, { recipients: ['solo@example.com'] });
    const id = emailIds[0] as string;
    const transport = new StubTransport();
    transport.failWith = Object.assign(new Error('timeout after DATA'), { code: 'ETIMEDOUT', command: 'DATA' });
    const { processor } = buildProcessor({ transport });

    await expect(processor(fakeJob({ emailId: id, reservedSlotAt: Date.now() }))).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    const row = await prisma.email.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.errorMessage).toContain('timeout after DATA');
  });
});

describe('worker: Elasticsearch sync', () => {
  beforeEach(resetState);

  it('updates the search document when an email is sent', async () => {
    const { user } = await createUser();
    const { emailIds } = await scheduleNow(user.id, { recipients: ['searchable@example.com'] });
    const id = emailIds[0] as string;
    const { processor } = buildProcessor();

    let scheduled = await searchService.search({ userId: user.id, kind: 'scheduled', page: 1, pageSize: 10 });
    expect(scheduled.items.map((i) => i.id)).toEqual([id]);

    await processor(fakeJob({ emailId: id, reservedSlotAt: Date.now() }));
    await searchService.refresh();

    scheduled = await searchService.search({ userId: user.id, kind: 'scheduled', page: 1, pageSize: 10 });
    const sent = await searchService.search({ userId: user.id, kind: 'sent', page: 1, pageSize: 10 });
    expect(scheduled.total).toBe(0);
    expect(sent.items[0]).toMatchObject({ id, status: 'SENT', recipientEmail: 'searchable@example.com' });
    expect(sent.items[0]?.sentAt).toBeTruthy();
  });
});
