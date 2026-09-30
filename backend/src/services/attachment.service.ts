import type { Prisma } from '@prisma/client';
import { sha256 } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_EMAIL = 5;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Uploads never linked to a campaign are removed after this long. */
const ORPHAN_TTL_MS = 24 * 3600 * 1000;

/** Executable / script types are never accepted as attachments. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'jar', 'app', 'sh', 'cpl', 'hta', 'lnk', 'reg', 'iso', 'img',
]);

export const publicAttachmentSelect = {
  id: true,
  filename: true,
  contentType: true,
  size: true,
  createdAt: true,
} satisfies Prisma.AttachmentSelect;

export type PublicAttachment = Prisma.AttachmentGetPayload<{ select: typeof publicAttachmentSelect }>;

/** Strips paths and control characters; keeps a readable name. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').trim().slice(0, 200);
  return cleaned || 'file';
}

export function isBlockedFilename(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return name.includes('.') && BLOCKED_EXTENSIONS.has(ext);
}

export async function saveAttachment(
  userId: string,
  file: { originalname: string; mimetype: string; buffer: Buffer },
): Promise<PublicAttachment> {
  const filename = sanitizeFilename(file.originalname);
  if (file.buffer.length === 0) throw AppError.badRequest('File is empty');
  if (file.buffer.length > MAX_ATTACHMENT_BYTES) {
    throw AppError.badRequest(`Each attachment must be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  }
  if (isBlockedFilename(filename)) throw AppError.badRequest('Executable and script files cannot be attached');

  await deleteOrphanAttachments(userId);
  return prisma.attachment.create({
    data: {
      userId,
      filename,
      contentType: file.mimetype || 'application/octet-stream',
      size: file.buffer.length,
      sha256: sha256(file.buffer.toString('base64')),
      data: new Uint8Array(file.buffer),
    },
    select: publicAttachmentSelect,
  });
}

/**
 * Validates attachment ids for a schedule request: they must belong to the user,
 * and be either unlinked or already linked to `campaignId` (idempotent replay).
 */
export async function assertAttachable(userId: string, ids: string[], campaignId?: string): Promise<void> {
  if (ids.length === 0) return;
  if (ids.length > MAX_ATTACHMENTS_PER_EMAIL) {
    throw AppError.badRequest(`At most ${MAX_ATTACHMENTS_PER_EMAIL} attachments per email`);
  }
  const found = await prisma.attachment.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, campaignId: true, size: true },
  });
  if (found.length !== new Set(ids).size) throw AppError.badRequest('One or more attachments were not found');
  if (found.some((a) => a.campaignId && a.campaignId !== campaignId)) {
    throw AppError.badRequest('An attachment is already used by another scheduled email; upload it again');
  }
  const total = found.reduce((sum, a) => sum + a.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw AppError.badRequest(`Attachments may total at most ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  }
}

export function listCampaignAttachments(campaignId: string): Promise<PublicAttachment[]> {
  return prisma.attachment.findMany({
    where: { campaignId },
    select: publicAttachmentSelect,
    orderBy: { createdAt: 'asc' },
  });
}

export async function getAttachmentForDownload(userId: string, id: string) {
  const attachment = await prisma.attachment.findFirst({ where: { id, userId } });
  if (!attachment) throw AppError.notFound('Attachment not found');
  return attachment;
}

/** Removes a not-yet-scheduled upload (the ✕ on a compose tile). */
export async function deleteUnlinkedAttachment(userId: string, id: string): Promise<void> {
  const { count } = await prisma.attachment.deleteMany({ where: { id, userId, campaignId: null } });
  if (count === 0) throw AppError.notFound('Attachment not found or already scheduled');
}

/**
 * Cleans uploads that were never scheduled. Runs opportunistically on upload
 * and once at worker startup — no recurring timer.
 */
export async function deleteOrphanAttachments(userId?: string): Promise<number> {
  const { count } = await prisma.attachment.deleteMany({
    where: { campaignId: null, createdAt: { lt: new Date(Date.now() - ORPHAN_TTL_MS) }, ...(userId ? { userId } : {}) },
  });
  if (count > 0) logger.info({ count }, 'orphan attachments removed');
  return count;
}
