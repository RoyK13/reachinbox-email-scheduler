import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/lib/crypto';
import { isSafeToRetrySmtpError } from '../../src/services/mail.service';
import { formatRateLimitMessage } from '../../src/utils/slack-message';

describe('secret encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const enc = encryptSecret('xoxb-super-secret');
    expect(enc).not.toContain('xoxb');
    expect(decryptSecret(enc)).toBe('xoxb-super-secret');
  });

  it('uses a fresh IV per encryption', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptSecret('value').split('.');
    const tampered = [v, iv, tag, `${ct}A`].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe('SMTP retry safety', () => {
  const err = (code: string, command?: string) => Object.assign(new Error(code), { code, command });

  it('retries failures that happen before the server could accept the message', () => {
    expect(isSafeToRetrySmtpError(err('ECONNECTION', 'CONN'))).toBe(true);
    expect(isSafeToRetrySmtpError(err('EAUTH', 'AUTH PLAIN'))).toBe(true);
    expect(isSafeToRetrySmtpError(err('ETIMEDOUT', 'CONN'))).toBe(true);
  });

  it('never retries once DATA may have been accepted', () => {
    expect(isSafeToRetrySmtpError(err('ETIMEDOUT', 'DATA'))).toBe(false);
    expect(isSafeToRetrySmtpError(err('ETIMEDOUT'))).toBe(false);
    expect(isSafeToRetrySmtpError(err('EMESSAGE', 'DATA'))).toBe(false);
    expect(isSafeToRetrySmtpError(new Error('boom'))).toBe(false);
  });
});

describe('Slack rate-limit message', () => {
  it('contains the required fields', () => {
    const text = formatRateLimitMessage({
      senderEmail: 'sender@example.com',
      hourlyLimit: 200,
      hitWindow: '2026-10-01T10',
      resumeAt: new Date('2026-10-01T11:00:00Z'),
      remainingScheduled: 137,
    });
    expect(text).toContain('ReachInbox rate limit reached.');
    expect(text).toContain('sender@example.com');
    expect(text).toContain('200');
    expect(text).toContain('10:00–10:59');
    expect(text).toContain('137');
    expect(text).toContain('next available hour window');
  });
});
