import { Router } from 'express';
import * as slack from '../controllers/slack.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { authRateLimit } from '../middleware/rate-limit.middleware';

export const slackRouter = Router()
  .get('/connect', authRateLimit, requireAuth, slack.connect)
  // Slack redirects the browser here; the user is identified by the single-use state.
  .get('/callback', authRateLimit, slack.callback)
  .get('/status', requireAuth, slack.status)
  .delete('/disconnect', requireAuth, slack.disconnect);
