import type { Response } from 'express';
import type { ApiSuccess } from '../types/api';

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data } satisfies ApiSuccess<T>);
}
