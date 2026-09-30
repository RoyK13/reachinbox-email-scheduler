import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.middleware';
import { emailStats, getEmail, listEmails } from '../services/email.service';
import { scheduleEmails } from '../services/scheduler.service';
import type { EmailListKind } from '../types/email';
import { ok } from '../utils/http';
import { emailIdParamSchema, listEmailsQuerySchema, scheduleEmailsSchema } from '../validators/email.schemas';

export async function schedule(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const input = scheduleEmailsSchema.parse(req.body);
  const result = await scheduleEmails(user.id, input);
  ok(res, result, result.idempotentReplay ? 200 : 201);
}

export function list(kind: EmailListKind) {
  return async (req: Request, res: Response): Promise<void> => {
    const user = currentUser(req);
    const query = listEmailsQuerySchema.parse(req.query);
    ok(res, await listEmails(user.id, kind, query));
  };
}

export async function stats(req: Request, res: Response): Promise<void> {
  ok(res, await emailStats(currentUser(req).id));
}

export async function detail(req: Request, res: Response): Promise<void> {
  const { id } = emailIdParamSchema.parse(req.params);
  ok(res, await getEmail(currentUser(req).id, id));
}
