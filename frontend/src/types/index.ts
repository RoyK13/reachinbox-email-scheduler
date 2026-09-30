export type EmailStatus = 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED';
export type EmailListKind = 'scheduled' | 'sent';

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: Array<{ path: string; message: string }> };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface Sender {
  id: string;
  name: string;
  email: string;
  enabled: boolean;
}

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
  /** Author shown in the From header (the signed-in user). */
  fromName: string;
  fromEmail: string;
  /** SMTP sending account ("via"). */
  senderName: string;
  attachments: Array<{ id: string; filename: string; contentType: string; size: number }>;
  campaignId: string;
  sequenceNumber: number;
  messageId: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailStats {
  scheduled: number;
  sent: number;
}

export interface ScheduleRequest {
  subject: string;
  body: string;
  recipients: string[];
  /** UTC ISO-8601 */
  startTime: string;
  delayBetweenEmailsMs: number;
  hourlyLimit: number;
  idempotencyKey: string;
  senderIds?: string[];
  attachmentIds?: string[];
}

export interface UploadedAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
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

export interface SlackStatus {
  connected: boolean;
  teamId: string | null;
  teamName: string | null;
  connectedAt: string | null;
}
