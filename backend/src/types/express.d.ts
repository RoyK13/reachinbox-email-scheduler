import 'express-session';
import type { AuthUser } from './api';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    googleOAuth?: {
      state: string;
      codeVerifier: string;
    };
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
