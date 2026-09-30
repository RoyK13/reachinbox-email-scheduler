import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import helmet from 'helmet';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Serves the built React app (frontend/dist) from the API server, so a single
 * service hosts everything on one origin (the session cookie stays first-party).
 * Returns null when no build is present — e.g. local dev, where Vite serves it.
 */
export function createFrontendRouter(): Router | null {
  const dir = env.FRONTEND_DIST_DIR ?? path.resolve(process.cwd(), '../frontend/dist');
  const indexHtml = path.join(dir, 'index.html');
  if (!existsSync(indexHtml)) return null;
  logger.info({ dir }, 'serving frontend build');

  return Router()
    .use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            // TipTap and React set inline styles; Google Fonts stylesheet.
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            // Google profile pictures + image attachment previews (blob:).
            imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
          },
        },
      }),
    )
    .use(express.static(dir, { index: false, maxAge: '1y', immutable: true, fallthrough: true }))
    .get(/^(?!\/api(\/|$)).*/, (_req, res) => {
      // Client-side routes (/scheduled, /compose, …) all load the SPA shell.
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
}
