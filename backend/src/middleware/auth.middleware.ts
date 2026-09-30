import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { findAuthUser } from '../services/auth.service';
import { AppError } from '../utils/errors';

/** Resolves the user from the server-side session. Client-supplied user ids are never trusted. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) throw AppError.unauthenticated();
  const user = await findAuthUser(userId);
  if (!user) {
    req.session.userId = undefined;
    throw AppError.unauthenticated('Session user no longer exists');
  }
  req.user = user;
  next();
}

/** Browser-facing pages (Bull Board): send signed-out users to the login screen instead of JSON. */
export async function requireAuthOrRedirect(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  const user = userId ? await findAuthUser(userId) : null;
  if (!user) {
    res.redirect(`${env.FRONTEND_URL}/login`);
    return;
  }
  req.user = user;
  next();
}

/** For handlers mounted behind requireAuth. */
export function currentUser(req: Request) {
  if (!req.user) throw AppError.unauthenticated();
  return req.user;
}
