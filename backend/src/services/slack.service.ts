import { WebClient } from '@slack/web-api';
import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { decryptSecret, encryptSecret, randomToken } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis as sharedRedis } from '../lib/redis';
import { AppError, errorMessage } from '../utils/errors';
import { formatRateLimitMessage } from '../utils/slack-message';

/** Bot scopes: post messages, and open a DM with the installing user. */
export const SLACK_BOT_SCOPES = ['chat:write', 'im:write'];
const STATE_TTL_SECONDS = 600;
const NOTIFY_DEDUPE_TTL_MS = 2 * 3600 * 1000;

export interface SlackStatus {
  connected: boolean;
  teamId: string | null;
  teamName: string | null;
  connectedAt: string | null;
}

export interface RateLimitNotice {
  userId: string;
  senderId: string;
  senderEmail: string;
  hourlyLimit: number;
  /** UTC hour window the limit was reached in, e.g. "2026-10-01T10" (also the dedupe unit). */
  hitWindow: string;
  resumeAt: Date;
}

export type SlackClientFactory = (token?: string) => WebClient;
const defaultClientFactory: SlackClientFactory = (token) => new WebClient(token);

export function notifyDedupeKey(userId: string, senderId: string, hitWindow: string): string {
  return `slack-rate-limit-notified:${userId}:${senderId}:${hitWindow}`;
}

export class SlackService {
  constructor(
    private readonly redis: Redis = sharedRedis,
    private readonly clientFactory: SlackClientFactory = defaultClientFactory,
  ) {}

  /** Build the Slack authorize URL; state is stored in Redis (not the cookie session) so an https tunnel works. */
  async createAuthorizeUrl(userId: string): Promise<string> {
    const state = randomToken(24);
    await this.redis.set(`slack-oauth-state:${state}`, userId, 'EX', STATE_TTL_SECONDS);
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', env.SLACK_CLIENT_ID);
    url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', env.SLACK_REDIRECT_URI);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Validate state (single use), exchange the code, and upsert the connection. */
  async handleCallback(code: string, state: string): Promise<{ userId: string; teamName: string | null }> {
    const userId = await this.redis.getdel(`slack-oauth-state:${state}`);
    if (!userId) throw new AppError(400, 'OAUTH_ERROR', 'Slack OAuth state is invalid or expired');

    const res = await this.clientFactory().oauth.v2.access({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: env.SLACK_REDIRECT_URI,
    });
    const accessToken = res.access_token;
    const teamId = res.team?.id;
    const slackUserId = res.authed_user?.id;
    if (!res.ok || !accessToken || !teamId || !slackUserId) {
      throw new AppError(400, 'OAUTH_ERROR', `Slack OAuth failed: ${res.error ?? 'missing token'}`);
    }

    const data = {
      teamId,
      teamName: res.team?.name ?? null,
      slackUserId,
      accessTokenEnc: encryptSecret(accessToken),
      scope: res.scope ?? null,
      connectedAt: new Date(),
    };
    await prisma.slackConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    logger.info({ userId, teamId }, 'slack oauth connected');
    return { userId, teamName: data.teamName };
  }

  async status(userId: string): Promise<SlackStatus> {
    const conn = await prisma.slackConnection.findUnique({
      where: { userId },
      select: { teamId: true, teamName: true, connectedAt: true },
    });
    return {
      connected: Boolean(conn),
      teamId: conn?.teamId ?? null,
      teamName: conn?.teamName ?? null,
      connectedAt: conn?.connectedAt.toISOString() ?? null,
    };
  }

  async disconnect(userId: string): Promise<boolean> {
    const conn = await prisma.slackConnection.findUnique({ where: { userId } });
    if (!conn) return false;
    try {
      await this.clientFactory(decryptSecret(conn.accessTokenEnc)).auth.revoke();
    } catch (err) {
      logger.warn({ userId, err: errorMessage(err) }, 'slack token revoke failed (connection removed anyway)');
    }
    await prisma.slackConnection.deleteMany({ where: { userId } });
    logger.info({ userId }, 'slack disconnected');
    return true;
  }

  /**
   * Sends the rate-limit alert at most once per tenant/sender/hour window,
   * across all workers (Redis SET NX). Never throws: Slack being disconnected
   * or down must not affect email processing. Returns true if a message was sent.
   */
  async notifyRateLimit(notice: RateLimitNotice): Promise<boolean> {
    const dedupeKey = notifyDedupeKey(notice.userId, notice.senderId, notice.hitWindow);
    let claimed = false;
    try {
      // Read on every call (no caching) so a connection made later works without restart.
      const conn = await prisma.slackConnection.findUnique({ where: { userId: notice.userId } });
      if (!conn) return false;

      claimed = (await this.redis.set(dedupeKey, '1', 'PX', NOTIFY_DEDUPE_TTL_MS, 'NX')) === 'OK';
      if (!claimed) return false;

      const remainingScheduled = await prisma.email.count({
        where: { userId: notice.userId, senderId: notice.senderId, status: 'SCHEDULED' },
      });
      const client = this.clientFactory(decryptSecret(conn.accessTokenEnc));
      const dm = await client.conversations.open({ users: conn.slackUserId });
      const channel = dm.channel?.id ?? conn.slackUserId;
      const text = formatRateLimitMessage({ ...notice, remainingScheduled });
      await client.chat.postMessage({ channel, text, mrkdwn: true });

      logger.info(
        { userId: notice.userId, senderId: notice.senderId, window: notice.hitWindow, remainingScheduled },
        'slack rate-limit notification sent',
      );
      return true;
    } catch (err) {
      logger.error(
        { userId: notice.userId, senderId: notice.senderId, err: errorMessage(err) },
        'slack rate-limit notification failed',
      );
      // Release the claim so the next rate-limited job in this window can retry the alert.
      if (claimed) await this.redis.del(dedupeKey).catch(() => undefined);
      return false;
    }
  }
}

export const slackService = new SlackService();
