import { Router } from 'express';
import multer from 'multer';
import * as attachments from '../controllers/attachment.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { MAX_ATTACHMENT_BYTES } from '../services/attachment.service';

// Memory storage: the file goes straight into PostgreSQL, never onto local disk.
const uploadOne = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
}).single('file');

export const attachmentRouter = Router()
  .use(requireAuth)
  .post('/', uploadOne, attachments.upload)
  .get('/:id', attachments.download)
  .delete('/:id', attachments.remove);
