import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { searchService } from '../../src/services/elasticsearch.service';
import { scheduleEmails } from '../../src/services/scheduler.service';
import { authCookie, createUser, resetState } from '../helpers';

const app = createApp();
let userA: string;
let userB: string;

beforeAll(async () => {
  await resetState();
  userA = (await createUser('A')).user.id;
  userB = (await createUser('B')).user.id;
  const start = new Date(Date.now() + 3_600_000);
  await scheduleEmails(userA, {
    subject: 'Quarterly roadmap review',
    body: '<p>Roadmap</p>',
    recipients: ['alice.smith@acme.io', 'bob@globex.com'],
    startTime: start,
    delayBetweenEmailsMs: 2000,
    hourlyLimit: 100,
    idempotencyKey: 'search-a-1',
  });
  await scheduleEmails(userA, {
    subject: 'Invoice reminder',
    body: '<p>Pay up</p>',
    recipients: ['carol@initech.com'],
    startTime: start,
    delayBetweenEmailsMs: 2000,
    hourlyLimit: 100,
    idempotencyKey: 'search-a-2',
  });
  await scheduleEmails(userB, {
    subject: 'Quarterly roadmap for B',
    body: '<p>Other tenant</p>',
    recipients: ['alice.smith@acme.io'],
    startTime: start,
    delayBetweenEmailsMs: 2000,
    hourlyLimit: 100,
    idempotencyKey: 'search-b-1',
  });
  await searchService.refresh();
});

describe('Elasticsearch search', () => {
  it('indexes every scheduled email', async () => {
    const res = await searchService.search({ userId: userA, kind: 'scheduled', page: 1, pageSize: 25 });
    expect(res.total).toBe(3);
    expect(res.items.every((i) => i.status === 'SCHEDULED')).toBe(true);
  });

  it('finds emails by (partial) recipient address', async () => {
    const full = await searchService.search({ userId: userA, kind: 'scheduled', q: 'carol@initech.com', page: 1, pageSize: 25 });
    expect(full.items.map((i) => i.recipientEmail)).toEqual(['carol@initech.com']);

    const partial = await searchService.search({ userId: userA, kind: 'scheduled', q: 'globex', page: 1, pageSize: 25 });
    expect(partial.items.map((i) => i.recipientEmail)).toEqual(['bob@globex.com']);
  });

  it('finds emails by subject words and prefixes', async () => {
    const word = await searchService.search({ userId: userA, kind: 'scheduled', q: 'invoice', page: 1, pageSize: 25 });
    expect(word.items.map((i) => i.subject)).toEqual(['Invoice reminder']);

    const prefix = await searchService.search({ userId: userA, kind: 'scheduled', q: 'roadm', page: 1, pageSize: 25 });
    expect(prefix.total).toBe(2);
    expect(prefix.items.every((i) => i.subject === 'Quarterly roadmap review')).toBe(true);
  });

  it('never returns another user’s emails', async () => {
    const b = await searchService.search({ userId: userB, kind: 'scheduled', q: 'roadmap', page: 1, pageSize: 25 });
    expect(b.items.map((i) => i.subject)).toEqual(['Quarterly roadmap for B']);

    const bByAddress = await searchService.search({ userId: userB, kind: 'scheduled', q: 'globex', page: 1, pageSize: 25 });
    expect(bByAddress.total).toBe(0);
  });

  it('paginates through the API', async () => {
    const cookie = await authCookie(userA);
    const page1 = await request(app).get('/api/emails/scheduled?page=1&pageSize=2').set('Cookie', cookie);
    const page2 = await request(app).get('/api/emails/scheduled?page=2&pageSize=2').set('Cookie', cookie);
    expect(page1.body.data).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(page1.body.data.items).toHaveLength(2);
    expect(page2.body.data.items).toHaveLength(1);

    const searched = await request(app).get('/api/emails/scheduled?q=invoice').set('Cookie', cookie);
    expect(searched.body.data.items).toHaveLength(1);

    const sent = await request(app).get('/api/emails/sent').set('Cookie', cookie);
    expect(sent.body.data).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });

  it('returns sidebar counts', async () => {
    const res = await request(app).get('/api/emails/stats').set('Cookie', await authCookie(userA));
    expect(res.body.data).toEqual({ scheduled: 3, sent: 0 });
  });
});
