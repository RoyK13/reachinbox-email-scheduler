import { prisma } from '../lib/prisma';
import type { Paginated } from '../types/api';
import type { EmailDetail, EmailListItem, EmailListKind } from '../types/email';
import { AppError } from '../utils/errors';
import { listCampaignAttachments } from './attachment.service';
import { LIST_STATUSES, searchService, toSearchDocument } from './elasticsearch.service';

export async function listEmails(
  userId: string,
  kind: EmailListKind,
  query: { q?: string | undefined; page: number; pageSize: number },
): Promise<Paginated<EmailListItem>> {
  try {
    return await searchService.search({ userId, kind, ...query });
  } catch {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Search is temporarily unavailable');
  }
}

/** Sidebar counts. Straight from PostgreSQL, the source of truth. */
export async function emailStats(userId: string): Promise<Record<EmailListKind, number>> {
  const groups = await prisma.email.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } });
  const count = (kind: EmailListKind) =>
    groups.filter((g) => LIST_STATUSES[kind].includes(g.status)).reduce((sum, g) => sum + g._count._all, 0);
  return { scheduled: count('scheduled'), sent: count('sent') };
}

export async function getEmail(userId: string, id: string): Promise<EmailDetail> {
  // Scoped by userId: another tenant's id is indistinguishable from a missing one.
  const email = await prisma.email.findFirst({
    where: { id, userId },
    include: { sender: { select: { email: true, name: true } }, user: { select: { name: true, email: true } } },
  });
  if (!email) throw AppError.notFound('Email not found');
  const doc = toSearchDocument(email);
  const attachments = await listCampaignAttachments(email.campaignId);
  return {
    id: doc.id,
    recipientEmail: doc.recipientEmail,
    subject: doc.subject,
    bodyPreview: doc.bodyPreview,
    status: doc.status,
    senderId: doc.senderId,
    senderEmail: doc.senderEmail,
    scheduledAt: doc.scheduledAt,
    sentAt: doc.sentAt,
    failedAt: doc.failedAt,
    etherealPreviewUrl: doc.etherealPreviewUrl,
    errorMessage: doc.errorMessage,
    body: email.body,
    fromName: email.user.name,
    fromEmail: email.user.email,
    senderName: email.sender.name,
    attachments: attachments.map(({ id, filename, contentType, size }) => ({ id, filename, contentType, size })),
    campaignId: email.campaignId,
    sequenceNumber: email.sequenceNumber,
    messageId: email.messageId,
    attemptCount: email.attemptCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
