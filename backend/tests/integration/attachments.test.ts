import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { authCookie, buildProcessor, createUser, fakeJob, resetState, scheduleBody, StubTransport } from '../helpers';

const app = createApp();
const PDF = Buffer.from('%PDF-1.4 fake pdf for tests');

async function upload(cookie: string, name = 'brochure.pdf', content = PDF) {
  return request(app).post('/api/attachments').set('Cookie', cookie).attach('file', content, name);
}

describe('attachments', () => {
  beforeEach(resetState);

  it('requires authentication', async () => {
    const res = await request(app).post('/api/attachments').attach('file', PDF, 'a.pdf');
    expect(res.status).toBe(401);
  });

  it('uploads a file and returns metadata only', async () => {
    const { user } = await createUser();
    const res = await upload(await authCookie(user.id));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ filename: 'brochure.pdf', contentType: 'application/pdf', size: PDF.length });
    expect(res.body.data.data).toBeUndefined();
  });

  it('rejects executables, empty files and oversized files', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    expect((await upload(cookie, 'setup.exe')).status).toBe(400);
    expect((await upload(cookie, 'empty.txt', Buffer.alloc(0))).status).toBe(400);
    const big = await upload(cookie, 'big.pdf', Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it('links uploads to the campaign, sends them with every email, and lists them on the detail', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    const att = (await upload(cookie)).body.data;

    const scheduled = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie)
      .send(scheduleBody({ recipients: ['x@example.com'], attachmentIds: [att.id] }));
    expect(scheduled.status).toBe(201);
    const emailId = scheduled.body.data.emailIds[0] as string;
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).campaignId).toBe(
      scheduled.body.data.campaignId,
    );

    const transport = new StubTransport();
    const sendOptions: Array<Record<string, unknown>> = [];
    const original = transport.sendMail.bind(transport);
    transport.sendMail = async (opts) => {
      sendOptions.push(opts);
      return original(opts);
    };
    await buildProcessor({ transport }).processor(fakeJob({ emailId, reservedSlotAt: Date.now() }));
    const sentAttachments = sendOptions[0]?.attachments as Array<{ filename: string; content: Buffer }>;
    expect(sentAttachments).toHaveLength(1);
    expect(sentAttachments[0]?.filename).toBe('brochure.pdf');
    expect(Buffer.from(sentAttachments[0]?.content ?? []).equals(PDF)).toBe(true);

    const detail = await request(app).get(`/api/emails/${emailId}`).set('Cookie', cookie);
    expect(detail.body.data.attachments).toEqual([
      { id: att.id, filename: 'brochure.pdf', contentType: 'application/pdf', size: PDF.length },
    ]);

    const download = await request(app).get(`/api/attachments/${att.id}`).set('Cookie', cookie).buffer(true);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment;');
  });

  it("never lets a user attach or download another user's file", async () => {
    const a = await createUser('A');
    const b = await createUser('B');
    const att = (await upload(await authCookie(a.user.id))).body.data;
    const cookieB = await authCookie(b.user.id);

    const res = await request(app).post('/api/emails/schedule').set('Cookie', cookieB).send(scheduleBody({ attachmentIds: [att.id] }));
    expect(res.status).toBe(400);
    expect((await request(app).get(`/api/attachments/${att.id}`).set('Cookie', cookieB)).status).toBe(404);
  });

  it('an upload can only be linked to one campaign, but idempotent replays still work', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    const att = (await upload(cookie)).body.data;
    const body = scheduleBody({ attachmentIds: [att.id] });

    expect((await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body)).status).toBe(201);
    expect((await request(app).post('/api/emails/schedule').set('Cookie', cookie).send(body)).status).toBe(200);
    const reuse = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie)
      .send(scheduleBody({ attachmentIds: [att.id] }));
    expect(reuse.status).toBe(400);
  });

  it('lets the user remove an upload before scheduling', async () => {
    const { user } = await createUser();
    const cookie = await authCookie(user.id);
    const att = (await upload(cookie)).body.data;
    expect((await request(app).delete(`/api/attachments/${att.id}`).set('Cookie', cookie)).status).toBe(200);
    expect(await prisma.attachment.count()).toBe(0);
  });
});
