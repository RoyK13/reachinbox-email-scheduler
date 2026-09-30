import { Router } from 'express';
import { health } from '../controllers/health.controller';
import { currentUser, requireAuth } from '../middleware/auth.middleware';
import { listSenders } from '../services/sender.service';
import { ok } from '../utils/http';
import { attachmentRouter } from './attachment.routes';
import { authRouter } from './auth.routes';
import { emailRouter } from './email.routes';
import { slackRouter } from './slack.routes';

const senderRouter = Router()
  .use(requireAuth)
  .get('/', async (req, res) => ok(res, await listSenders(currentUser(req).id)));

/** Everything under /api (Bull Board is mounted separately in app.ts). */
export const apiRouter = Router()
  .get('/health', health)
  .use('/auth', authRouter)
  .use('/emails', emailRouter)
  .use('/attachments', attachmentRouter)
  .use('/slack', slackRouter)
  .use('/senders', senderRouter);
