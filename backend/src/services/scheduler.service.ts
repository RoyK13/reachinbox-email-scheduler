import { randomUUID } from 'node:crypto';
import { Prisma, type Campaign } from '@prisma/client';
import { convert as htmlToText } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';
import { env } from '../config/env';
import { sha256 } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { enqueueEmails } from '../queues/email.queue';
import type { ScheduleResult } from '../types/email';
import { emailJobId } from '../types/queue';
import { AppError, errorMessage } from '../utils/errors';
import type { ScheduleEmailsInput } from '../validators/email.schemas';
import {
  assignSendersRoundRobin,
  effectiveDelayMs,
  effectiveHourlyLimit,
  initialScheduleTimes,
} from '../utils/scheduling';
import { assertAttachable } from './attachment.service';
import { searchService } from './elasticsearch.service';
import { listEnabledSenders, type PublicSender } from './sender.service';

const INSERT_CHUNK = 1_000;
const INDEX_CHUNK = 1_000;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'span', 'u', 's'],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    '*': ['style'],
  },
  allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
};

function requestHash(input: ScheduleEmailsInput): string {
  return sha256(
    JSON.stringify({
      subject: input.subject,
      body: input.body,
      recipients: input.recipients,
      startTime: input.startTime.toISOString(),
      delayBetweenEmailsMs: input.delayBetweenEmailsMs,
      hourlyLimit: input.hourlyLimit,
      senderIds: input.senderIds ? [...input.senderIds].sort() : null,
      attachmentIds: [...input.attachmentIds].sort(),
    }),
  );
}

async function buildResultForCampaign(campaign: Campaign, idempotentReplay: boolean): Promise<ScheduleResult> {
  const [emails, bounds, perSender] = await Promise.all([
    prisma.email.findMany({ where: { campaignId: campaign.id }, select: { id: true }, orderBy: { sequenceNumber: 'asc' } }),
    prisma.email.aggregate({ where: { campaignId: campaign.id }, _min: { scheduledAt: true }, _max: { scheduledAt: true } }),
    prisma.email.groupBy({ by: ['senderId'], where: { campaignId: campaign.id }, _count: { _all: true } }),
  ]);
  const senders = await prisma.sender.findMany({
    where: { id: { in: perSender.map((s) => s.senderId) } },
    select: { id: true, email: true },
  });
  const senderEmail = new Map(senders.map((s) => [s.id, s.email]));
  return {
    campaignId: campaign.id,
    idempotentReplay,
    totalRecipients: campaign.totalRecipients,
    emailIds: emails.map((e) => e.id),
    firstScheduledAt: (bounds._min.scheduledAt ?? campaign.startTime).toISOString(),
    lastScheduledAt: (bounds._max.scheduledAt ?? campaign.startTime).toISOString(),
    effectiveDelayBetweenEmailsMs: campaign.delayBetweenEmailsMs,
    effectiveHourlyLimit: campaign.hourlyLimit,
    senders: perSender.map((s) => ({ id: s.senderId, email: senderEmail.get(s.senderId) ?? '', assigned: s._count._all })),
  };
}

/**
 * Makes sure every still-SCHEDULED email of a campaign has its BullMQ job.
 * Safe to call repeatedly: jobIds are deterministic, so BullMQ ignores duplicates.
 */
export async function ensureCampaignJobs(campaignId: string): Promise<number> {
  const pending = await prisma.email.findMany({
    where: { campaignId, status: 'SCHEDULED' },
    select: { id: true, scheduledAt: true },
    orderBy: { sequenceNumber: 'asc' },
  });
  return enqueueEmails(pending.map((e) => ({ emailId: e.id, scheduledAt: e.scheduledAt })));
}

async function handleExistingCampaign(existing: Campaign, hash: string): Promise<ScheduleResult> {
  if (existing.requestHash !== hash) {
    throw AppError.conflict(
      'IDEMPOTENCY_CONFLICT',
      'This idempotencyKey was already used for a different schedule request',
    );
  }
  // A previous attempt may have committed rows but crashed before enqueueing.
  await ensureCampaignJobs(existing.id);
  logger.info({ campaignId: existing.id }, 'idempotent schedule replay');
  return buildResultForCampaign(existing, true);
}

/**
 * Validated request → campaign + one email row per recipient (single
 * transaction, bulk inserts) → one delayed BullMQ job per email (addBulk)
 * → Elasticsearch bulk index. No sending happens on the request path.
 */
export async function scheduleEmails(
  userId: string,
  rawInput: Omit<ScheduleEmailsInput, 'attachmentIds'> & { attachmentIds?: string[] },
): Promise<ScheduleResult> {
  const input: ScheduleEmailsInput = { ...rawInput, attachmentIds: rawInput.attachmentIds ?? [] };
  const hash = requestHash(input);
  const existing = await prisma.campaign.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) return handleExistingCampaign(existing, hash);

  const senders = await listEnabledSenders(userId, input.senderIds);
  if (senders.length === 0) {
    throw new AppError(422, 'NO_SENDERS', 'No enabled sender accounts are configured (see ETHEREAL_SENDERS_JSON)');
  }
  if (input.senderIds && senders.length !== new Set(input.senderIds).size) {
    throw AppError.badRequest('One or more senderIds are unknown or disabled');
  }
  await assertAttachable(userId, input.attachmentIds);

  const delayMs = effectiveDelayMs(input.delayBetweenEmailsMs, env.MIN_EMAIL_DELAY_MS);
  const hourlyLimit = effectiveHourlyLimit(input.hourlyLimit, env.MAX_EMAILS_PER_HOUR_PER_SENDER);
  const bodyHtml = sanitizeHtml(input.body, SANITIZE_OPTIONS);
  const bodyText = htmlToText(bodyHtml, { wordwrap: 100 });

  const campaignId = randomUUID();
  const assigned: PublicSender[] = assignSendersRoundRobin(input.recipients.length, senders);
  const times = initialScheduleTimes(input.startTime, input.recipients.length, senders.length, delayMs);
  const rows: Prisma.EmailCreateManyInput[] = input.recipients.map((recipientEmail, i) => {
    const id = randomUUID();
    return {
      id,
      userId,
      campaignId,
      senderId: (assigned[i] as PublicSender).id,
      recipientEmail,
      subject: input.subject,
      body: bodyHtml,
      scheduledAt: times[i] as Date,
      status: 'SCHEDULED',
      bullJobId: emailJobId(id),
      idempotencyKey: `${campaignId}:${i}`,
      sequenceNumber: i,
    };
  });

  let campaign: Campaign;
  try {
    campaign = await prisma.$transaction(
      async (tx) => {
        const created = await tx.campaign.create({
          data: {
            id: campaignId,
            userId,
            idempotencyKey: input.idempotencyKey,
            requestHash: hash,
            subject: input.subject,
            bodyHtml,
            bodyText,
            startTime: input.startTime,
            delayBetweenEmailsMs: delayMs,
            hourlyLimit,
            totalRecipients: rows.length,
          },
        });
        if (input.attachmentIds.length > 0) {
          // Only still-unlinked uploads of this user; a concurrent request can't claim them twice.
          const linked = await tx.attachment.updateMany({
            where: { id: { in: input.attachmentIds }, userId, campaignId: null },
            data: { campaignId },
          });
          if (linked.count !== input.attachmentIds.length) {
            throw AppError.badRequest('An attachment is already used by another scheduled email; upload it again');
          }
        }
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          await tx.email.createMany({ data: rows.slice(i, i + INSERT_CHUNK) });
        }
        return created;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    // Concurrent request with the same key won the unique constraint race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.campaign.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
      });
      if (winner) return handleExistingCampaign(winner, hash);
    }
    throw err;
  }

  logger.info(
    { userId, campaignId, recipients: rows.length, senders: senders.length, delayMs, hourlyLimit },
    'emails scheduled',
  );

  // If this throws, rows are committed; startup reconciliation (or an idempotent
  // retry of this request) re-creates the missing jobs.
  const enqueued = await enqueueEmails(rows.map((r) => ({ emailId: r.id as string, scheduledAt: r.scheduledAt as Date })));
  logger.info({ campaignId, jobs: enqueued }, 'jobs enqueued');

  await indexCampaign(campaignId);

  const senderEmail = new Map(senders.map((s) => [s.id, s.email]));
  const perSender = new Map<string, number>();
  for (const s of assigned) perSender.set(s.id, (perSender.get(s.id) ?? 0) + 1);

  return {
    campaignId: campaign.id,
    idempotentReplay: false,
    totalRecipients: rows.length,
    emailIds: rows.map((r) => r.id as string),
    firstScheduledAt: (times[0] as Date).toISOString(),
    lastScheduledAt: (times[times.length - 1] as Date).toISOString(),
    effectiveDelayBetweenEmailsMs: delayMs,
    effectiveHourlyLimit: hourlyLimit,
    senders: [...perSender.entries()].map(([id, assignedCount]) => ({
      id,
      email: senderEmail.get(id) ?? '',
      assigned: assignedCount,
    })),
  };
}

async function indexCampaign(campaignId: string): Promise<void> {
  try {
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.email.findMany({
        where: { campaignId },
        include: { sender: { select: { email: true } } },
        orderBy: { id: 'asc' },
        take: INDEX_CHUNK,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      await searchService.indexEmails(batch, { refresh: batch.length < INDEX_CHUNK });
      cursor = batch[batch.length - 1]?.id;
      if (batch.length < INDEX_CHUNK) break;
    }
  } catch (err) {
    logger.error({ campaignId, err: errorMessage(err) }, 'indexing scheduled campaign failed (run `npm run reindex`)');
  }
}
