import type { Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { currentUser } from '../middleware/auth.middleware';
import { SESSION_COOKIE } from '../middleware/session.middleware';
import { completeGoogleAuth, startGoogleAuth } from '../services/auth.service';
import { errorMessage } from '../utils/errors';
import { ok } from '../utils/http';

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function loginRedirect(res: Response, error: string): void {
  res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(error)}`);
}

export async function googleStart(req: Request, res: Response): Promise<void> {
  const { url, state, codeVerifier } = await startGoogleAuth();
  req.session.googleOAuth = { state, codeVerifier };
  await saveSession(req);
  res.redirect(url);
}

export async function googleCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query;
  const pending = req.session.googleOAuth;
  req.session.googleOAuth = undefined;

  if (typeof error === 'string') return loginRedirect(res, 'google_denied');
  if (typeof code !== 'string' || typeof state !== 'string' || !pending || pending.state !== state) {
    logger.warn('google oauth callback with missing or mismatched state');
    return loginRedirect(res, 'invalid_state');
  }

  try {
    const user = await completeGoogleAuth(code, pending.codeVerifier);
    // New session id on privilege change (prevents session fixation).
    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);
    res.redirect(`${env.FRONTEND_URL}/scheduled`);
  } catch (err) {
    logger.error({ err: errorMessage(err) }, 'google oauth callback failed');
    loginRedirect(res, 'google_failed');
  }
}

export function me(req: Request, res: Response): void {
  ok(res, currentUser(req));
}

export async function logout(req: Request, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  ok(res, { loggedOut: true });
}
