import { Router } from 'express';
import * as emails from '../controllers/email.controller';
import { requireAuth } from '../middleware/auth.middleware';

export const emailRouter = Router()
  .use(requireAuth)
  .post('/schedule', emails.schedule)
  .get('/scheduled', emails.list('scheduled'))
  .get('/sent', emails.list('sent'))
  .get('/stats', emails.stats)
  .get('/:id', emails.detail);
