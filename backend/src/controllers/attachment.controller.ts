import type { Request, Response } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth.middleware';
import { deleteUnlinkedAttachment, getAttachmentForDownload, saveAttachment } from '../services/attachment.service';
import { AppError } from '../utils/errors';
import { ok } from '../utils/http';

const idParam = z.object({ id: z.string().uuid() });

export async function upload(req: Request, res: Response): Promise<void> {
  if (!req.file) throw AppError.badRequest('Attach a file in the "file" form field');
  ok(res, await saveAttachment(currentUser(req).id, req.file), 201);
}

export async function download(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  const file = await getAttachmentForDownload(currentUser(req).id, id);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Length', String(file.size));
  // Always a download, never rendered inline in our origin.
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(Buffer.from(file.data));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = idParam.parse(req.params);
  await deleteUnlinkedAttachment(currentUser(req).id, id);
  ok(res, { deleted: true });
}
