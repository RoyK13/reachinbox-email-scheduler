import { Router } from 'express';
import * as auth from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { authRateLimit } from '../middleware/rate-limit.middleware';

export const authRouter = Router()
  .get('/google', authRateLimit, auth.googleStart)
  .get('/google/callback', authRateLimit, auth.googleCallback)
  .get('/me', requireAuth, auth.me)
  .post('/logout', auth.logout);
