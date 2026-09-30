import { z } from 'zod';
import { env } from '../config/env';

/** Clock-skew tolerance for "startTime must be in the future". */
export const START_TIME_SKEW_MS = 5_000;
const MAX_HOURLY_LIMIT = 100_000;
const MAX_DELAY_MS = 3_600_000;

const emailAddress = z.string().trim().toLowerCase().email();

/**
 * Deduplicates recipients while preserving first-seen order (order drives
 * sequenceNumber and therefore send order).
 */
export function normalizeRecipients(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const email = raw.trim().toLowerCase();
    if (!seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

export const scheduleEmailsSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(998),
  body: z.string().trim().min(1, 'Body is required').max(200_000),
  recipients: z
    .array(emailAddress, { required_error: 'recipients is required' })
    .min(1, 'At least one recipient is required')
    .max(env.MAX_RECIPIENTS_PER_REQUEST * 2, 'Too many recipients')
    .transform(normalizeRecipients)
    .refine((list) => list.length <= env.MAX_RECIPIENTS_PER_REQUEST, {
      message: `At most ${env.MAX_RECIPIENTS_PER_REQUEST} unique recipients per request`,
    }),
  startTime: z
    .string()
    .datetime({ offset: true, message: 'startTime must be an ISO-8601 timestamp' })
    .transform((v) => new Date(v))
    .refine((d) => d.getTime() >= Date.now() - START_TIME_SKEW_MS, { message: 'startTime must be in the future' }),
  delayBetweenEmailsMs: z.number().int().positive('delayBetweenEmailsMs must be positive').max(MAX_DELAY_MS),
  hourlyLimit: z.number().int().positive('hourlyLimit must be positive').max(MAX_HOURLY_LIMIT),
  idempotencyKey: z
    .string()
    .trim()
    .min(8, 'idempotencyKey must be at least 8 characters')
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/, 'idempotencyKey may only contain letters, digits and . _ : -'),
  senderIds: z.array(z.string().uuid()).max(50).optional(),
  /** Ids returned by POST /api/attachments. */
  attachmentIds: z
    .array(z.string().uuid())
    .max(5, 'At most 5 attachments per email')
    .default([])
    .transform((ids) => [...new Set(ids)]),
});

export type ScheduleEmailsInput = z.infer<typeof scheduleEmailsSchema>;

export const listEmailsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine((v) => v.page * v.pageSize <= 10_000, { message: 'Page is beyond the searchable window (10,000 results)' });

export const emailIdParamSchema = z.object({ id: z.string().uuid() });
