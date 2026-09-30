import type { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { currentUser } from '../middleware/auth.middleware';
import { slackService } from '../services/slack.service';
import { errorMessage } from '../utils/errors';
import { ok } from '../utils/http';

/** Browser navigates here; we redirect to Slack's consent screen. */
export async function connect(req: Request, res: Response): Promise<void> {
  const url = await slackService.createAuthorizeUrl(currentUser(req).id);
  res.redirect(url);
}

export async function callback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query;
  const back = (result: string) => res.redirect(`${env.FRONTEND_URL}/scheduled?slack=${result}`);

  if (typeof error === 'string') return back('denied');
  if (typeof code !== 'string' || typeof state !== 'string') return back('error');
  try {
    await slackService.handleCallback(code, state);
    back('connected');
  } catch (err) {
    logger.error({ err: errorMessage(err) }, 'slack oauth callback failed');
    back('error');
  }
}

export async function status(req: Request, res: Response): Promise<void> {
  ok(res, await slackService.status(currentUser(req).id));
}

export async function disconnect(req: Request, res: Response): Promise<void> {
  const removed = await slackService.disconnect(currentUser(req).id);
  ok(res, { disconnected: removed });
}
