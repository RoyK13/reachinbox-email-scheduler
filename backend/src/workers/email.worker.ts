import { Worker } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { createRedis, redis } from '../lib/redis';
import { EMAIL_QUEUE_NAME } from '../queues/email.queue';
import { createEmailProcessor, type ProcessOutcome } from '../services/email-processor.service';
import { searchService } from '../services/elasticsearch.service';
import { MailService } from '../services/mail.service';
import { RateLimiterService } from '../services/rate-limiter.service';
import { slackService } from '../services/slack.service';
import type { EmailJobData, SEND_EMAIL_JOB } from '../types/queue';

export const mailService = new MailService();

export function createEmailWorker(): Worker<EmailJobData, ProcessOutcome, typeof SEND_EMAIL_JOB> {
  const processor = createEmailProcessor({
    prisma,
    rateLimiter: new RateLimiterService(redis),
    mail: mailService,
    search: searchService,
    slack: slackService,
    logger,
  });

  const worker = new Worker<EmailJobData, ProcessOutcome, typeof SEND_EMAIL_JOB>(EMAIL_QUEUE_NAME, processor, {
    connection: createRedis('worker'),
    concurrency: env.WORKER_CONCURRENCY,
    // Long SMTP handshakes shouldn't be mistaken for a stalled worker.
    lockDuration: 120_000,
    autorun: false,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'job failed');
  });
  worker.on('error', (err) => logger.error({ err: err.message }, 'worker error'));
  return worker;
}
