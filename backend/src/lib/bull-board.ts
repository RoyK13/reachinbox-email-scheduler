import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { emailQueue } from '../queues/email.queue';

export const BULL_BOARD_PATH = '/api/admin/queues';

/** Live BullMQ dashboard: waiting / active / delayed / completed / failed. */
export function createBullBoardRouter() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue, { readOnlyMode: false })],
    serverAdapter,
    options: { uiConfig: { boardTitle: 'ReachInbox Queues' } },
  });
  return serverAdapter.getRouter();
}
