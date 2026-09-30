import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { encryptSecret } from '../../src/lib/crypto';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { notifyDedupeKey, SlackService } from '../../src/services/slack.service';
import { authCookie, createUser, resetState, slackMock } from '../helpers';

const app = createApp();

function notice(userId: string, senderId: string) {
  return {
    userId,
    senderId,
    senderEmail: 'sender@ethereal.email',
    hourlyLimit: 200,
    hitWindow: '2030-01-01T10',
    resumeAt: new Date('2030-01-01T11:00:00Z'),
  };
}

describe('Slack integration', () => {
  beforeEach(resetState);

  it('does nothing (and does not throw) when Slack is not connected', async () => {
    const { user, senders } = await createUser();
    const mock = slackMock();
    const service = new SlackService(redis, mock.factory);
    await expect(service.notifyRateLimit(notice(user.id, senders[0]?.id as string))).resolves.toBe(false);
    expect(mock.posted).toHaveLength(0);
  });

  it('sends a real chat.postMessage for a connected workspace', async () => {
    const { user, senders } = await createUser();
    await prisma.slackConnection.create({
      data: { userId: user.id, teamId: 'T1', slackUserId: 'U1', accessTokenEnc: encryptSecret('xoxb-live') },
    });
    const mock = slackMock();
    const service = new SlackService(redis, mock.factory);

    await expect(service.notifyRateLimit(notice(user.id, senders[0]?.id as string))).resolves.toBe(true);
    expect(mock.tokens).toContain('xoxb-live');
    expect(mock.posted).toEqual([{ channel: 'D123', text: expect.stringContaining('Hourly limit:* 200') }]);
  });

  it('deduplicates the alert per sender/hour across concurrent workers', async () => {
    const { user, senders } = await createUser();
    await prisma.slackConnection.create({
      data: { userId: user.id, teamId: 'T1', slackUserId: 'U1', accessTokenEnc: encryptSecret('xoxb-live') },
    });
    const mock = slackMock();
    const services = Array.from({ length: 5 }, () => new SlackService(redis, mock.factory));
    const senderId = senders[0]?.id as string;

    const results = await Promise.all(services.map((s) => s.notifyRateLimit(notice(user.id, senderId))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mock.posted).toHaveLength(1);
    expect(await redis.exists(notifyDedupeKey(user.id, senderId, '2030-01-01T10'))).toBe(1);

    // A different sender or hour window is a separate alert.
    await services[0]?.notifyRateLimit({ ...notice(user.id, senders[1]?.id as string) });
    await services[0]?.notifyRateLimit({ ...notice(user.id, senderId), hitWindow: '2030-01-01T11' });
    expect(mock.posted).toHaveLength(3);
  });

  it('picks up a connection made after startup (no caching)', async () => {
    const { user, senders } = await createUser();
    const mock = slackMock();
    const service = new SlackService(redis, mock.factory);
    expect(await service.notifyRateLimit(notice(user.id, senders[0]?.id as string))).toBe(false);

    await prisma.slackConnection.create({
      data: { userId: user.id, teamId: 'T1', slackUserId: 'U1', accessTokenEnc: encryptSecret('xoxb-later') },
    });
    expect(await service.notifyRateLimit(notice(user.id, senders[0]?.id as string))).toBe(true);
  });

  it('exposes connection status without the token, and disconnects', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    await prisma.slackConnection.create({
      data: { userId: user.id, teamId: 'T1', teamName: 'Acme', slackUserId: 'U1', accessTokenEnc: encryptSecret('xoxb-secret') },
    });

    const status = await request(app).get('/api/slack/status').set('Cookie', cookie);
    expect(status.body.data).toMatchObject({ connected: true, teamName: 'Acme' });
    expect(JSON.stringify(status.body)).not.toContain('xoxb');

    // Disconnect path (auth.revoke failure is tolerated).
    const del = await request(app).delete('/api/slack/disconnect').set('Cookie', cookie);
    expect(del.status).toBe(200);
    expect(await prisma.slackConnection.count()).toBe(0);
    const after = await request(app).get('/api/slack/status').set('Cookie', cookie);
    expect(after.body.data.connected).toBe(false);
  });

  it('starts OAuth with chat:write + a single-use state, and rejects unknown states', async () => {
    const { user } = await createUser();
    const res = await request(app).get('/api/slack/connect').set('Cookie', await authCookie(user.id));
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('scope')).toContain('chat:write');
    const state = url.searchParams.get('state') as string;
    expect(await redis.get(`slack-oauth-state:${state}`)).toBe(user.id);

    const bad = await request(app).get('/api/slack/callback?code=x&state=unknown');
    expect(bad.headers.location).toContain('slack=error');
  });
});
