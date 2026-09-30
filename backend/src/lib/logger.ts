import pino from 'pino';
import { env, isProduction } from '../config/env';

/**
 * Structured logger. Secret-bearing fields are redacted wherever they appear,
 * so a stray `logger.info({ sender })` can never leak an SMTP password or token.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'reachinbox' },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.password',
      '*.pass',
      '*.smtpPassword',
      '*.smtpPasswordEnc',
      '*.accessToken',
      '*.accessTokenEnc',
      '*.access_token',
      '*.token',
      '*.clientSecret',
      '*.client_secret',
    ],
    censor: '[redacted]',
  },
  ...(isProduction || env.NODE_ENV === 'test'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }),
});

export type Logger = typeof logger;
