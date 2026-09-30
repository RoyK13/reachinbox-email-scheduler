/** BullMQ payload for the `send-email` job. The DB row is the source of truth. */
export interface EmailJobData {
  emailId: string;
  /**
   * Send slot (epoch ms) already reserved in Redis by the rate limiter.
   * Set when a job was moved back to delayed so it does not reserve twice.
   */
  reservedSlotAt?: number;
}

export const SEND_EMAIL_JOB = 'send-email';

/**
 * Deterministic BullMQ job id derived from the DB id, e.g. "email-3f2c…".
 * (BullMQ 5 rejects ":" in custom ids — it is its own Redis key separator.)
 */
export function emailJobId(emailId: string): string {
  return `email-${emailId}`;
}
