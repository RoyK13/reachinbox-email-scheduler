import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import signature from 'cookie-signature';
import type { SentMessageInfo } from 'nodemailer';
import { env } from '../../src/config/env';
import { logger } from '../../src/lib/logger';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { SESSION_COOKIE, sessionStore } from '../../src/middleware/session.middleware';
import { emailQueue } from '../../src/queues/email.queue';
import { createEmailProcessor } from '../../src/services/email-processor.service';
import { searchService } from '../../src/services/elasticsearch.service';
import { MailService, type MailTransport } from '../../src/services/mail.service';
import { RateLimiterService } from '../../src/services/rate-limiter.service';
import { SlackService, type SlackClientFactory } from '../../src/services/slack.service';
import { syncSendersForUser } from '../../src/services/sender.service';
import type { EmailJobData } from '../../src/types/queue';

/** Wipes every test resource: DB rows, Redis DB 1, queue, ES test index. */
export async function resetState(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "emails", "campaigns", "senders", "slack_connections", "users" RESTART IDENTITY CASCADE',
  );
  await emailQueue.obliterate({ force: true });
  await redis.flushdb();
  await searchService.deleteIndex();
  await searchService.ensureIndex();
}

export async function createUser(name = 'Test User') {
  const id = randomUUID();
  const user = await prisma.user.create({
    data: { googleId: `google-${id}`, email: `${id.slice(0, 8)}@example.com`, name, avatarUrl: null },
  });
  await syncSendersForUser(user.id);
  const senders = await prisma.sender.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { user, senders };
}

/** Creates a real session in the Redis session store and returns the signed cookie header. */
export async function authCookie(userId: string): Promise<string> {
  const sid = randomUUID();
  await new Promise<void>((resolve, reject) =>
    sessionStore.set(
      sid,
      { cookie: { originalMaxAge: 3_600_000, httpOnly: true, path: '/' }, userId } as never,
      (err: unknown) => (err ? reject(err) : resolve()),
    ),
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(`s:${signature.sign(sid, env.SESSION_SECRET)}`)}`;
}

/** Records every sendMail call; behaves like an SMTP server that accepts everything. */
export class StubTransport implements MailTransport {
  readonly sent: Array<Record<'to' | 'subject' | 'messageId' | 'from' | 'replyTo' | 'sender' | 'envelope', unknown>> = [];
  failWith: (Error & { code?: string; command?: string }) | null = null;

  async sendMail(options: Record<string, unknown>): Promise<SentMessageInfo> {
    if (this.failWith) throw this.failWith;
    const { to, subject, messageId, from, replyTo, sender, envelope } = options;
    this.sent.push({ to, subject, messageId, from, replyTo, sender, envelope });
    return {
      messageId: String(options.messageId),
      accepted: [String(options.to)],
      rejected: [],
      envelope: {},
      response: '250 Accepted',
    } as SentMessageInfo;
  }
  close(): void {}
}

export interface SlackMock {
  factory: SlackClientFactory;
  posted: Array<{ channel: string; text: string }>;
  tokens: Array<string | undefined>;
}

export function slackMock(): SlackMock {
  const posted: SlackMock['posted'] = [];
  const tokens: SlackMock['tokens'] = [];
  const factory = ((token?: string) => {
    tokens.push(token);
    return {
      conversations: { open: async () => ({ ok: true, channel: { id: 'D123' } }) },
      chat: {
        postMessage: async (args: { channel: string; text: string }) => {
          posted.push({ channel: args.channel, text: args.text });
          return { ok: true };
        },
      },
      auth: { revoke: async () => ({ ok: true }) },
    };
  }) as unknown as SlackClientFactory;
  return { factory, posted, tokens };
}

export function buildProcessor(opts: { transport?: StubTransport; slack?: SlackService } = {}) {
  const transport = opts.transport ?? new StubTransport();
  const slack = opts.slack ?? new SlackService(redis, slackMock().factory);
  const processor = createEmailProcessor({
    prisma,
    rateLimiter: new RateLimiterService(redis),
    mail: new MailService(() => transport),
    search: searchService,
    slack,
    logger,
  });
  return { processor, transport, slack };
}

/** Minimal in-memory stand-in for a BullMQ Job, for driving the processor directly. */
export function fakeJob(data: EmailJobData, overrides: Partial<{ attemptsMade: number; attempts: number }> = {}) {
  const job = {
    id: `email-${data.emailId}`,
    data: { ...data },
    opts: { attempts: overrides.attempts ?? 3 },
    attemptsMade: overrides.attemptsMade ?? 0,
    movedTo: null as number | null,
    async updateData(next: EmailJobData) {
      job.data = next;
    },
    async moveToDelayed(ts: number) {
      job.movedTo = ts;
    },
  };
  return job as typeof job & Job<EmailJobData>;
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function scheduleBody(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'Quarterly roadmap review',
    body: '<p>Hello from <strong>ReachInbox</strong></p>',
    recipients: ['alice@example.com', 'bob@example.com', 'carol@example.com'],
    startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    delayBetweenEmailsMs: 2000,
    hourlyLimit: 100,
    idempotencyKey: `test-${randomUUID()}`,
    ...overrides,
  };
}
