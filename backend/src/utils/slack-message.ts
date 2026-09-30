import { hourWindowRange } from './time';

export interface RateLimitMessageInput {
  senderEmail: string;
  hourlyLimit: number;
  /** Full hour window, e.g. "2026-10-01T10". */
  hitWindow: string;
  resumeAt: Date;
  remainingScheduled: number;
}

export function formatRateLimitMessage(n: RateLimitMessageInput): string {
  return [
    ':warning: *ReachInbox rate limit reached.*',
    '',
    `*Sender:* ${n.senderEmail}`,
    `*Hourly limit:* ${n.hourlyLimit}`,
    `*Current window:* ${hourWindowRange(n.hitWindow)}`,
    `*Remaining scheduled emails:* ${n.remainingScheduled}`,
    `Emails will resume in the next available hour window (from ${n.resumeAt.toISOString()}).`,
  ].join('\n');
}
