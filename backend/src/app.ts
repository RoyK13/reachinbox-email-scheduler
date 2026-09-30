import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env, isProduction } from './config/env';
import { BULL_BOARD_PATH, createBullBoardRouter } from './lib/bull-board';
import { createFrontendRouter } from './lib/frontend';
import { logger } from './lib/logger';
import { requireAuthOrRedirect } from './middleware/auth.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { sessionMiddleware } from './middleware/session.middleware';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  if (isProduction) app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      // Query strings are dropped: OAuth callbacks carry authorization codes.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(sessionMiddleware);

  // Bull Board serves its own inline-script UI, so it gets a relaxed CSP; it is auth-protected.
  if (env.BULL_BOARD_ENABLED) {
    app.use(BULL_BOARD_PATH, helmet({ contentSecurityPolicy: false }), requireAuthOrRedirect, createBullBoardRouter());
  }

  app.use('/api', helmet(), apiRouter);

  // Single-service deployments: the built frontend is served from here too.
  const frontend = createFrontendRouter();
  if (frontend) app.use(frontend);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
