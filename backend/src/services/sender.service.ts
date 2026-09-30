import type { Prisma, Sender } from '@prisma/client';
import { env, type SenderConfig } from '../config/env';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

/** Public sender shape — never includes SMTP credentials. */
export const publicSenderSelect = {
  id: true,
  name: true,
  email: true,
  enabled: true,
  createdAt: true,
} satisfies Prisma.SenderSelect;

export type PublicSender = Prisma.SenderGetPayload<{ select: typeof publicSenderSelect }>;

export interface SmtpCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Provision the configured Ethereal senders for a user (tenant). Idempotent:
 * upserts by (userId, email) so credential rotations in .env propagate, and
 * disables senders that were removed from the configuration.
 */
export async function syncSendersForUser(
  userId: string,
  configs: SenderConfig[] = env.ETHEREAL_SENDERS_JSON,
): Promise<void> {
  const emails = configs.map((c) => c.email.toLowerCase());
  await prisma.$transaction([
    ...configs.map((c) =>
      prisma.sender.upsert({
        where: { userId_email: { userId, email: c.email.toLowerCase() } },
        create: {
          userId,
          name: c.name,
          email: c.email.toLowerCase(),
          smtpHost: c.host,
          smtpPort: c.port,
          smtpSecure: c.secure,
          smtpUser: c.user,
          smtpPasswordEnc: encryptSecret(c.pass),
          enabled: true,
        },
        update: {
          name: c.name,
          smtpHost: c.host,
          smtpPort: c.port,
          smtpSecure: c.secure,
          smtpUser: c.user,
          smtpPasswordEnc: encryptSecret(c.pass),
          enabled: true,
        },
      }),
    ),
    prisma.sender.updateMany({ where: { userId, email: { notIn: emails } }, data: { enabled: false } }),
  ]);
}

/** Startup: refresh sender config for every existing user. */
export async function syncSendersForAllUsers(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true } });
  for (const user of users) await syncSendersForUser(user.id);
  logger.info({ users: users.length, senders: env.ETHEREAL_SENDERS_JSON.length }, 'sender configuration synced');
}

export function listSenders(userId: string): Promise<PublicSender[]> {
  return prisma.sender.findMany({
    where: { userId },
    select: publicSenderSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/** Enabled senders in a stable order — the basis of deterministic round-robin. */
export function listEnabledSenders(userId: string, senderIds?: string[]): Promise<PublicSender[]> {
  return prisma.sender.findMany({
    where: { userId, enabled: true, ...(senderIds?.length ? { id: { in: senderIds } } : {}) },
    select: publicSenderSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export function smtpCredentials(sender: Sender): SmtpCredentials {
  return {
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    user: sender.smtpUser,
    pass: decryptSecret(sender.smtpPasswordEnc),
  };
}
