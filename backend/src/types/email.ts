import type { EmailStatus } from '@prisma/client';

export type { EmailStatus };

/** Validated + normalized POST /api/emails/schedule body. */
export interface ScheduleRequest {
  subject: string;
  body: string;
  recipients: string[];
  startTime: Date;
  delayBetweenEmailsMs: number;
  hourlyLimit: number;
  idempotencyKey: string;
  senderIds?: string[];
}

export interface ScheduleResult {
  campaignId: string;
  idempotentReplay: boolean;
  totalRecipients: number;
  emailIds: string[];
  firstScheduledAt: string;
  lastScheduledAt: string;
  effectiveDelayBetweenEmailsMs: number;
  effectiveHourlyLimit: number;
  senders: Array<{ id: string; email: string; assigned: number }>;
}

/** Shape returned by the list endpoints (backed by Elasticsearch). */
export interface EmailListItem {
  id: string;
  recipientEmail: string;
  subject: string;
  bodyPreview: string;
  status: EmailStatus;
  senderId: string;
  senderEmail: string;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  etherealPreviewUrl: string | null;
  errorMessage: string | null;
}

export interface EmailDetail extends EmailListItem {
  body: string;
  /** Author shown in the From header (the user who scheduled it). */
  fromName: string;
  fromEmail: string;
  /** SMTP sending account the email goes out through ("via"). */
  senderName: string;
  attachments: Array<{ id: string; filename: string; contentType: string; size: number }>;
  campaignId: string;
  sequenceNumber: number;
  messageId: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Document stored in the Elasticsearch `emails` index. */
export interface EmailSearchDocument {
  id: string;
  userId: string;
  campaignId: string;
  senderId: string;
  senderEmail: string;
  recipientEmail: string;
  subject: string;
  bodyPreview: string;
  status: EmailStatus;
  etherealPreviewUrl: string | null;
  errorMessage: string | null;
  sequenceNumber: number;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  /** sentAt ?? failedAt — sort key for the Sent tab. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EmailListKind = 'scheduled' | 'sent';
