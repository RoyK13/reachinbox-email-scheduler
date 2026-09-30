import { createApp } from './app';
import { env } from './config/env';
import { connectInfrastructure, onShutdown } from './lib/lifecycle';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { emailQueue } from './queues/email.queue';
import { syncSendersForAllUsers } from './services/sender.service';
import { errorMessage } from './utils/errors';

async function main(): Promise<void> {
  await connectInfrastructure();
  await syncSendersForAllUsers();

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, frontend: env.FRONTEND_URL }, 'API listening');
  });

  onShutdown([
    { name: 'http', close: () => new Promise((resolve) => server.close(resolve)) },
    { name: 'queue', close: () => emailQueue.close() },
    { name: 'redis', close: () => redis.quit() },
    { name: 'prisma', close: () => prisma.$disconnect() },
  ]);
}

main().catch((err) => {
  logger.fatal({ err: errorMessage(err) }, 'API failed to start');
  process.exit(1);
});
