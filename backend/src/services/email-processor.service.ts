import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../lib/logger';
import type { EmailJobData } from '../types/queue';
import { errorMessage } from '../utils/errors';
import { hourIndex, hourWindowLabel, sleep } from '../utils/time';
import type { ElasticsearchService } from './elasticsearch.service';
import { isSafeToRetrySmtpError, type MailService } from './mail.service';
import { SLOT_TOLERANCE_MS, type RateLimiterService } from './rate-limiter.service';
import type { SlackService } from './slack.service';

export interface EmailProcessorDeps {
  prisma: PrismaClient;
  rateLimiter: RateLimiterService;
  mail: MailService;
  search: ElasticsearchService;
  slack: SlackService;
  logger: Logger;
}

export type ProcessOutcome =
  | { result: 'sent'; messageId: string; previewUrl: string | null }
  | { result: 'skipped'; reason: string }
  | { result: 'rescheduled'; slotAt: number; rateLimited: boolean };

/**
 * Handles one `send-email` job:
 *
 *   load row → still SCHEDULED? → reserve Redis send slot (min delay + hourly limit)
 *     → slot in the future? move job back to delayed (no sleeping, no failure)
 *     → atomic claim SCHEDULED→SENDING (only one worker can win)
 *     → SMTP → SENT (+messageId, preview URL) → Elasticsearch
 */
export function createEmailProcessor(deps: EmailProcessorDeps) {
  const { prisma, rateLimiter, mail, search, slack, logger } = deps;

  async function reindex(emailId: string): Promise<void> {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: { sender: { select: { email: true } } },
    });
    if (email) await search.indexEmail(email);
  }

  async function reschedule(
    job: Job<EmailJobData>,
    token: string | undefined,
    emailId: string,
    slotAt: number,
  ): Promise<never> {
    await prisma.email.updateMany({
      where: { id: emailId, status: 'SCHEDULED' },
      data: { scheduledAt: new Date(slotAt) },
    });
    await reindex(emailId);
    await job.updateData({ emailId, reservedSlotAt: slotAt });
    await job.moveToDelayed(slotAt, token);
    // Tells BullMQ the job was moved on purpose: not completed, not failed, no attempt used.
    throw new DelayedError();
  }

  return async function processEmailJob(job: Job<EmailJobData>, token?: string): Promise<ProcessOutcome> {
    const { emailId, reservedSlotAt } = job.data;
    const log = logger.child({ jobId: job.id, emailId });

    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: {
        sender: true,
        user: { select: { name: true, email: true } },
        campaign: { select: { delayBetweenEmailsMs: true, hourlyLimit: true } },
      },
    });
    if (!email) {
      log.warn('email row not found; dropping job');
      return { result: 'skipped', reason: 'not_found' };
    }
    // Duplicate delivery / already handled by another worker.
    if (email.status !== 'SCHEDULED') {
      log.info({ status: email.status }, 'email already handled; skipping duplicate job');
      return { result: 'skipped', reason: `status_${email.status.toLowerCase()}` };
    }
    if (!email.sender.enabled) {
      await prisma.email.updateMany({
        where: { id: emailId, status: 'SCHEDULED' },
        data: { status: 'FAILED', failedAt: new Date(), errorMessage: 'Sender account is disabled' },
      });
      await reindex(emailId);
      return { result: 'skipped', reason: 'sender_disabled' };
    }

    log.info({ attempt: job.attemptsMade + 1, sender: email.sender.email }, 'job started');

    // ---- 1. Distributed throttle ------------------------------------------------
    let slotAt: number;
    if (reservedSlotAt !== undefined) {
      // Slot already reserved on a previous pass; just wait for it (never reserve twice).
      slotAt = reservedSlotAt;
    } else {
      const decision = await rateLimiter.reserve({
        userId: email.userId,
        senderId: email.senderId,
        delayMs: email.campaign.delayBetweenEmailsMs,
        hourlyLimit: email.campaign.hourlyLimit,
      });
      slotAt = decision.slotAt;

      if (decision.status === 'RATE_LIMITED') {
        log.warn(
          { fullWindow: decision.hitWindow, limit: decision.limit, resumeAt: new Date(slotAt).toISOString() },
          'rate limit reached; email delayed to next available window',
        );
        // Alert is deduplicated per tenant/sender/current UTC hour across all workers.
        await slack.notifyRateLimit({
          userId: email.userId,
          senderId: email.senderId,
          senderEmail: email.sender.email,
          hourlyLimit: email.campaign.hourlyLimit,
          hitWindow: hourWindowLabel(hourIndex(Date.now())),
          resumeAt: new Date(slotAt),
        });
      }
    }

    const waitMs = slotAt - Date.now();
    if (waitMs > SLOT_TOLERANCE_MS) {
      log.info({ slotAt: new Date(slotAt).toISOString(), waitMs }, 'email delayed until reserved send slot');
      return reschedule(job, token, emailId, slotAt);
    }
    if (waitMs > 0) await sleep(waitMs);

    // Everything the SMTP call needs is loaded before the claim, so a DB error
    // here leaves the row SCHEDULED (retryable) rather than stuck in SENDING.
    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: email.campaignId },
      select: {
        bodyText: true,
        attachments: { select: { filename: true, contentType: true, data: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    // ---- 2. Atomic claim: SCHEDULED → SENDING. Exactly one worker can win. -------
    const now = new Date();
    const claim = await prisma.email.updateMany({
      where: { id: emailId, status: 'SCHEDULED' },
      data: { status: 'SENDING', sendStartedAt: now, lastAttemptAt: now, attemptCount: { increment: 1 } },
    });
    if (claim.count === 0) {
      log.info('lost claim race; another worker owns this email');
      return { result: 'skipped', reason: 'claim_lost' };
    }

    // ---- 3. SMTP ------------------------------------------------------------------
    const domain = email.sender.email.split('@')[1] ?? 'reachinbox.local';
    try {
      const sent = await mail.send(email.sender, {
        from: { name: email.user.name, address: email.user.email },
        to: email.recipientEmail,
        subject: email.subject,
        html: email.body,
        text: campaign.bodyText,
        messageId: `<${email.id}@${domain}>`,
        attachments: campaign.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: Buffer.from(a.data),
        })),
      });
      // SMTP accepted: from here on the email must never be sent again.
      await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          messageId: sent.messageId,
          etherealPreviewUrl: sent.previewUrl,
          errorMessage: null,
        },
      });
      await reindex(emailId);
      log.info({ messageId: sent.messageId, previewUrl: sent.previewUrl }, 'email sent');
      return { result: 'sent', messageId: sent.messageId, previewUrl: sent.previewUrl };
    } catch (err) {
      const message = errorMessage(err);
      const maxAttempts = job.opts.attempts ?? 1;
      const hasAttemptsLeft = job.attemptsMade + 1 < maxAttempts;

      if (isSafeToRetrySmtpError(err) && hasAttemptsLeft) {
        // Failed before the server accepted anything: hand the email back for a BullMQ retry.
        await prisma.email.updateMany({
          where: { id: emailId, status: 'SENDING' },
          data: { status: 'SCHEDULED', errorMessage: message },
        });
        await job.updateData({ emailId });
        await reindex(emailId);
        log.warn({ err: message, attempt: job.attemptsMade + 1 }, 'transient SMTP failure; will retry');
        throw err;
      }

      await prisma.email.updateMany({
        where: { id: emailId, status: 'SENDING' },
        data: { status: 'FAILED', failedAt: new Date(), errorMessage: message },
      });
      await reindex(emailId);
      log.error({ err: message }, 'email failed');
      // Non-retryable (or retries exhausted): outcome may be ambiguous, so never resend.
      throw new UnrecoverableError(message);
    }
  };
}
