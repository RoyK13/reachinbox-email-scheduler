import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { randomToken } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { AuthUser } from '../types/api';
import { AppError } from '../utils/errors';
import { syncSendersForUser } from './sender.service';

const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_CALLBACK_URL,
  });
}

export interface GoogleAuthStart {
  url: string;
  state: string;
  codeVerifier: string;
}

/** Authorization Code flow with state (CSRF) + PKCE (S256). */
export async function startGoogleAuth(): Promise<GoogleAuthStart> {
  const client = oauthClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomToken(24);
  const url = client.generateAuthUrl({
    access_type: 'online',
    scope: GOOGLE_SCOPES,
    state,
    prompt: 'select_account',
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge ?? '',
  });
  return { url, state, codeVerifier };
}

/** Exchange the code, verify the ID token signature/audience, and upsert the user. */
export async function completeGoogleAuth(code: string, codeVerifier: string): Promise<AuthUser> {
  const client = oauthClient();
  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.id_token) throw new AppError(400, 'OAUTH_ERROR', 'Google did not return an ID token');

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new AppError(400, 'OAUTH_ERROR', 'Google account has no email');
  if (payload.email_verified === false) throw new AppError(403, 'FORBIDDEN', 'Google email is not verified');

  const profile = {
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email,
    avatarUrl: payload.picture ?? null,
  };
  const user = await prisma.user.upsert({
    where: { googleId: payload.sub },
    create: { googleId: payload.sub, ...profile },
    update: profile,
  });
  await syncSendersForUser(user.id);
  logger.info({ userId: user.id }, 'google login succeeded');
  return toAuthUser(user);
}

export function toAuthUser(user: { id: string; name: string; email: string; avatarUrl: string | null }): AuthUser {
  return { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl };
}

export async function findAuthUser(userId: string): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user ? toAuthUser(user) : null;
}
