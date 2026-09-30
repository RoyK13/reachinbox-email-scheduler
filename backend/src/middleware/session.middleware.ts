import { RedisStore } from 'connect-redis';
import session from 'express-session';
import { env, isProduction } from '../config/env';
import { redis } from '../lib/redis';

export const SESSION_COOKIE = 'rib.sid';
export const SESSION_PREFIX = 'sess:';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export const sessionStore = new RedisStore({ client: redis, prefix: SESSION_PREFIX, ttl: SESSION_TTL_SECONDS });

export const sessionMiddleware = session({
  name: SESSION_COOKIE,
  store: sessionStore,
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: isProduction,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: SESSION_TTL_SECONDS * 1000,
  },
});
