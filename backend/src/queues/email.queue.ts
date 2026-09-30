import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env';
import { createRedis } from '../lib/redis';
import { SEND_EMAIL_JOB, emailJobId, type EmailJobData } from '../types/queue';

export const EMAIL_QUEUE_NAME = env.QUEUE_NAME;

/**
 * Retention keeps history visible in Bull Board (completed for 7 days, failed
 * for 30) while bounding Redis memory.
 */
export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export const emailQueue = new Queue<EmailJobData, void, typeof SEND_EMAIL_JOB>(EMAIL_QUEUE_NAME, {
  connection: createRedis('queue'),
  defaultJobOptions,
});

export interface EnqueueItem {
  emailId: string;
  scheduledAt: Date;
}

/**
 * Adds one delayed job per email. The jobId is deterministic ("email-<id>"),
 * so enqueueing the same email twice is a no-op in BullMQ.
 */
export async function enqueueEmails(items: EnqueueItem[], chunkSize = 500): Promise<number> {
  let added = 0;
  const now = Date.now();
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    await emailQueue.addBulk(
      chunk.map((item) => ({
        name: SEND_EMAIL_JOB,
        data: { emailId: item.emailId },
        opts: { jobId: emailJobId(item.emailId), delay: Math.max(0, item.scheduledAt.getTime() - now) },
      })),
    );
    added += chunk.length;
  }
  return added;
}
