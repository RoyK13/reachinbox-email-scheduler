import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { emailQueue } from '../../src/queues/email.queue';
import { emailJobId } from '../../src/types/queue';
import { authCookie, createUser, resetState, scheduleBody } from '../helpers';

const app = createApp();

describe('API: authentication', () => {
  beforeEach(resetState);

  it('rejects unauthenticated email API calls', async () => {
    for (const [method, path] of [
      ['get', '/api/emails/scheduled'],
      ['get', '/api/emails/sent'],
      ['post', '/api/emails/schedule'],
      ['get', '/api/auth/me'],
      ['get', '/api/senders'],
    ] as const) {
      const res = await request(app)[method](path);
      expect(res.status, path).toBe(401);
      expect(res.body).toEqual({ success: false, error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
    }
  });

  it('rejects a forged / unsigned session cookie', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', 'rib.sid=s%3Afake.signature');
    expect(res.status).toBe(401);
  });

  it('returns the session user from /api/auth/me', async () => {
    const { user } = await createUser('Ada Lovelace');
    const res = await request(app).get('/api/auth/me').set('Cookie', await authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: user.id, name: 'Ada Lovelace', email: user.email, avatarUrl: null });
  });

  it('never exposes SMTP credentials from /api/senders', async () => {
    const { user } = await createUser();
    const res = await request(app).get('/api/senders').set('Cookie', await authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/smtp|password|pass"|test-pass/i);
  });

  it('redirects /api/auth/google to Google with state + PKCE', async () => {
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(res.headers['set-cookie']?.[0]).toMatch(/HttpOnly/i);
  });

  it('rejects an OAuth callback with a mismatched state', async () => {
    const res = await request(app).get('/api/auth/google/callback?code=abc&state=wrong');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?error=invalid_state');
  });

  it('reports health of every dependency', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', services: { database: 'ok', redis: 'ok', elasticsearch: 'ok' } });
  });
});

describe('API: scheduling', () => {
  beforeEach(resetState);

  it('schedules emails for an authenticated user', async () => {
    const { user, senders } = await createUser();
    const body = scheduleBody();
    const res = await request(app).post('/api/emails/schedule').set('Cookie', await authCookie(user.id)).send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ totalRecipients: 3, idempotentReplay: false, effectiveHourlyLimit: 100 });
    expect(res.body.data.emailIds).toHaveLength(3);

    const rows = await prisma.email.findMany({ where: { userId: user.id }, orderBy: { sequenceNumber: 'asc' } });
    expect(rows.map((r) => r.recipientEmail)).toEqual(body.recipients);
    // Deterministic round robin across the two configured senders.
    expect(rows.map((r) => r.senderId)).toEqual([senders[0]?.id, senders[1]?.id, senders[0]?.id]);
    expect(rows.every((r) => r.status === 'SCHEDULED')).toBe(true);
    expect(rows.map((r) => r.bullJobId)).toEqual(rows.map((r) => emailJobId(r.id)));
  });

  it('creates one delayed BullMQ job per email with the correct delay + persisted timestamps', async () => {
    const { user } = await createUser();
    const start = new Date(Date.now() + 2 * 3600 * 1000);
    const body = scheduleBody({ startTime: start.toISOString(), delayBetweenEmailsMs: 5000 });
    const res = await request(app).post('/api/emails/schedule').set('Cookie', await authCookie(user.id)).send(body);
    expect(res.status).toBe(201);

    const rows = await prisma.email.findMany({ where: { userId: user.id }, orderBy: { sequenceNumber: 'asc' } });
    // 2 senders: seq 0,1 at start; seq 2 is sender A's 2nd email → start + 5s.
    expect(rows.map((r) => r.scheduledAt.getTime() - start.getTime())).toEqual([0, 0, 5000]);

    const counts = await emailQueue.getJobCounts('delayed', 'waiting', 'active');
    expect(counts).toMatchObject({ delayed: 3, waiting: 0, active: 0 });

    for (const row of rows) {
      const job = await emailQueue.getJob(emailJobId(row.id));
      expect(job?.data).toEqual({ emailId: row.id });
      expect(await job?.getState()).toBe('delayed');
      const runsAt = (job?.timestamp ?? 0) + (job?.delay ?? 0);
      expect(Math.abs(runsAt - row.scheduledAt.getTime())).toBeLessThan(2_000);
    }
  });

  it('floors the delay at MIN_EMAIL_DELAY_MS and caps the hourly limit', async () => {
    const { user } = await createUser();
    const res = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', await authCookie(user.id))
      .send(scheduleBody({ delayBetweenEmailsMs: 10, hourlyLimit: 5000 }));
    expect(res.status).toBe(201);
    expect(res.body.data.effectiveDelayBetweenEmailsMs).toBe(2000);
    expect(res.body.data.effectiveHourlyLimit).toBe(200);
  });

  it('returns useful validation errors', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);

    const bad = await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(scheduleBody({ recipients: ['nope'] }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.message).toMatch(/recipients/);

    const past = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie)
      .send(scheduleBody({ startTime: new Date(Date.now() - 3_600_000).toISOString() }));
    expect(past.status).toBe(400);
    expect(past.body.error.message).toMatch(/future/);

    const malformed = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send('{"subject":');
    expect(malformed.status).toBe(400);
    expect(await prisma.email.count()).toBe(0);
  });

  it('dedupes recipients within a request', async () => {
    const { user } = await createUser();
    const res = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', await authCookie(user.id))
      .send(scheduleBody({ recipients: ['a@example.com', 'A@EXAMPLE.com', 'b@example.com'] }));
    expect(res.status).toBe(201);
    expect(res.body.data.totalRecipients).toBe(2);
  });

  it('only returns a user’s own email by id', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    const res = await request(app).post('/api/emails/schedule').set('Cookie', await authCookie(a.user.id)).send(scheduleBody());
    const id = res.body.data.emailIds[0] as string;

    const own = await request(app).get(`/api/emails/${id}`).set('Cookie', await authCookie(a.user.id));
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ id, recipientEmail: 'alice@example.com', status: 'SCHEDULED' });

    const other = await request(app).get(`/api/emails/${id}`).set('Cookie', await authCookie(b.user.id));
    expect(other.status).toBe(404);
  });
});

describe('API: idempotency', () => {
  beforeEach(resetState);

  it('replaying the same idempotency key creates no duplicate rows or jobs', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    const body = scheduleBody();

    const first = await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body);
    const second = await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.idempotentReplay).toBe(true);
    expect(second.body.data.emailIds).toEqual(first.body.data.emailIds);
    expect(await prisma.email.count()).toBe(3);
    expect(await prisma.campaign.count()).toBe(1);
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(3);
  });

  it('concurrent duplicate requests produce exactly one campaign', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    const body = scheduleBody();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(3);
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(3);
  });

  it('rejects reuse of a key with a different payload', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    const body = scheduleBody();
    await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body);
    const res = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie)
      .send({ ...body, subject: 'Something else' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('scopes idempotency keys per user', async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    const body = scheduleBody();
    const ra = await request(app).post('/api/emails/schedule').set('Cookie', await authCookie(a.user.id)).send(body);
    const rb = await request(app).post('/api/emails/schedule').set('Cookie', await authCookie(b.user.id)).send(body);
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(await prisma.campaign.count()).toBe(2);
  });

  it('a replay repairs jobs that were never enqueued', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    const body = scheduleBody();
    const first = await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body);
    const lostId = first.body.data.emailIds[1] as string;
    await (await emailQueue.getJob(emailJobId(lostId)))?.remove();

    await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body);
    expect(await emailQueue.getJob(emailJobId(lostId))).toBeTruthy();
    expect((await emailQueue.getJobCounts('delayed')).delayed).toBe(3);
  });
});
