import { describe, expect, it } from 'vitest';
import { listEmailsQuerySchema, normalizeRecipients, scheduleEmailsSchema } from '../../src/validators/email.schemas';

const valid = () => ({
  subject: 'Hello',
  body: '<p>Hi</p>',
  recipients: ['A@Example.com', 'b@example.com'],
  startTime: new Date(Date.now() + 60_000).toISOString(),
  delayBetweenEmailsMs: 2000,
  hourlyLimit: 200,
  idempotencyKey: 'request-12345',
});

describe('schedule request validation', () => {
  it('accepts a valid request and normalizes recipients', () => {
    const parsed = scheduleEmailsSchema.parse({
      ...valid(),
      recipients: [' A@Example.com ', 'b@example.com', 'a@example.com'],
    });
    expect(parsed.recipients).toEqual(['a@example.com', 'b@example.com']);
    expect(parsed.startTime).toBeInstanceOf(Date);
  });

  it('rejects invalid email addresses', () => {
    const res = scheduleEmailsSchema.safeParse({ ...valid(), recipients: ['not-an-email'] });
    expect(res.success).toBe(false);
  });

  it('rejects a start time in the past', () => {
    const res = scheduleEmailsSchema.safeParse({ ...valid(), startTime: new Date(Date.now() - 60_000).toISOString() });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toMatch(/future/);
  });

  it.each([0, -5, 1.5])('rejects non-positive / fractional delay %s', (delay) => {
    expect(scheduleEmailsSchema.safeParse({ ...valid(), delayBetweenEmailsMs: delay }).success).toBe(false);
  });

  it.each([0, -1])('rejects non-positive hourly limit %s', (limit) => {
    expect(scheduleEmailsSchema.safeParse({ ...valid(), hourlyLimit: limit }).success).toBe(false);
  });

  it('rejects more than the maximum number of unique recipients', () => {
    const recipients = Array.from({ length: 10_001 }, (_, i) => `user${i}@example.com`);
    expect(scheduleEmailsSchema.safeParse({ ...valid(), recipients }).success).toBe(false);
  });

  it('requires an idempotency key', () => {
    const { idempotencyKey: _omit, ...rest } = valid();
    expect(scheduleEmailsSchema.safeParse(rest).success).toBe(false);
  });

  it('requires an empty recipient list to fail', () => {
    expect(scheduleEmailsSchema.safeParse({ ...valid(), recipients: [] }).success).toBe(false);
  });
});

describe('normalizeRecipients', () => {
  it('dedupes case-insensitively and keeps first-seen order', () => {
    expect(normalizeRecipients(['B@x.com', 'a@x.com', 'b@X.com '])).toEqual(['b@x.com', 'a@x.com']);
  });
});

describe('list query validation', () => {
  it('applies defaults', () => {
    expect(listEmailsQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 25 });
  });

  it('caps page size', () => {
    expect(listEmailsQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });
});
