import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { MAX_ATTACHMENT_BYTES } from '../services/attachment.service';
import { ZodError } from 'zod';
import { isProduction } from '../config/env';
import { logger } from '../lib/logger';
import type { ApiFailure } from '../types/api';
import { AppError } from '../utils/errors';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
}

function send(res: Response, status: number, error: ApiFailure['error']): void {
  res.status(status).json({ success: false, error } satisfies ApiFailure);
}

/** Central error handler: consistent JSON shape, no stack traces leave the server. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    send(res, 400, {
      code: 'VALIDATION_ERROR',
      message: first ? `${first.path.join('.') || 'request'}: ${first.message}` : 'Invalid request',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, path: req.path }, err.message);
    send(res, err.status, { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }

  // Body parser errors (malformed JSON, payload too large).
  if (typeof err === 'object' && err && 'type' in err && 'status' in err) {
    const e = err as { type: string; status: number; message: string };
    if (e.type === 'entity.parse.failed') return send(res, 400, { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' });
    if (e.type === 'entity.too.large') return send(res, 413, { code: 'VALIDATION_ERROR', message: 'Request body too large' });
  }

  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Each attachment must be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`
        : `Upload rejected: ${err.message}`;
    return send(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, { code: 'VALIDATION_ERROR', message });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    return send(res, 404, { code: 'NOT_FOUND', message: 'Resource not found' });
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  send(res, 500, {
    code: 'INTERNAL_ERROR',
    message: isProduction ? 'Something went wrong' : err instanceof Error ? err.message : 'Something went wrong',
  });
}
