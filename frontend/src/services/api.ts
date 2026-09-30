import axios, { AxiosError } from 'axios';
import type {
  ApiErrorBody,
  ApiSuccess,
  AuthUser,
  EmailDetail,
  EmailListItem,
  EmailListKind,
  EmailStats,
  Paginated,
  ScheduleRequest,
  ScheduleResult,
  Sender,
  SlackStatus,
  UploadedAttachment,
} from '../types';

/**
 * Backend base URL. Local dev defaults to the API on :4000. Production builds
 * default to the same origin ("" → relative /api): the backend serves the
 * built frontend itself, so the session cookie stays first-party.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '')).replace(
  /\/$/,
  '',
);

/** Session lives in an HTTP-only cookie; withCredentials sends it cross-port. */
const http = axios.create({ baseURL: `${API_URL}/api`, withCredentials: true, timeout: 60_000 });

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

function toApiError(err: unknown): ApiError {
  if (err instanceof AxiosError) {
    const body = err.response?.data as ApiErrorBody | undefined;
    if (body?.error) return new ApiError(body.error.message, err.response?.status ?? 0, body.error.code, body.error.details);
    if (!err.response) return new ApiError('Cannot reach the server. Is the backend running?', 0, 'NETWORK_ERROR');
    return new ApiError(err.message, err.response.status, 'HTTP_ERROR');
  }
  return new ApiError(err instanceof Error ? err.message : 'Unexpected error', 0, 'UNKNOWN');
}

async function unwrap<T>(p: Promise<{ data: ApiSuccess<T> }>): Promise<T> {
  try {
    return (await p).data.data;
  } catch (err) {
    throw toApiError(err);
  }
}

/** Full-page navigations (OAuth flows must be top-level redirects). */
export const urls = {
  googleLogin: `${API_URL}/api/auth/google`,
  slackConnect: `${API_URL}/api/slack/connect`,
  bullBoard: `${API_URL}/api/admin/queues`,
};

export const api = {
  me: () => unwrap<AuthUser>(http.get('/auth/me')),
  logout: () => unwrap<{ loggedOut: boolean }>(http.post('/auth/logout')),

  senders: () => unwrap<Sender[]>(http.get('/senders')),

  listEmails: (kind: EmailListKind, params: { q?: string; page: number; pageSize: number }) =>
    unwrap<Paginated<EmailListItem>>(http.get(`/emails/${kind}`, { params: { ...params, q: params.q || undefined } })),
  emailStats: () => unwrap<EmailStats>(http.get('/emails/stats')),
  email: (id: string) => unwrap<EmailDetail>(http.get(`/emails/${id}`)),
  schedule: (body: ScheduleRequest) => unwrap<ScheduleResult>(http.post('/emails/schedule', body)),

  uploadAttachment: (file: File, onProgress?: (fraction: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    return unwrap<UploadedAttachment>(
      http.post('/attachments', form, {
        onUploadProgress: (e) => e.total && onProgress?.(e.loaded / e.total),
      }),
    );
  },
  deleteAttachment: (id: string) => unwrap<{ deleted: boolean }>(http.delete(`/attachments/${id}`)),
  attachmentUrl: (id: string) => `${API_URL}/api/attachments/${id}`,

  slackStatus: () => unwrap<SlackStatus>(http.get('/slack/status')),
  slackDisconnect: () => unwrap<{ disconnected: boolean }>(http.delete('/slack/disconnect')),
};
