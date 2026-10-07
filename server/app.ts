import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import './types';
import type { AppConfig } from './config';
import { csrfGuard, projectScope, requireAuth, sessionLoader } from './auth';
import { HttpError } from './lib/http';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { projectCollectionRoutes, projectItemRoutes } from './routes/projects';
import { budgetRoutes } from './routes/budget';
import { categoryRoutes } from './routes/categories';
import { paymentRoutes } from './routes/payments';
import { materialRoutes } from './routes/materials';
import { visitRoutes } from './routes/visits';
import { timelineRoutes, workUpdateRoutes } from './routes/timeline';
import { notificationRoutes } from './routes/notifications';
import { Notifier } from './notify/notifier';
import { createWebPushSender, type PushSender } from './notify/push';
import { attachmentRoutes } from './routes/attachments';
import { directoryRoutes, projectDirectoryRoute } from './routes/directory';
import { contractRoutes } from './routes/contracts';
import { prerequisiteRoutes } from './routes/prerequisites';
import { dashboardRoutes, portfolioRoute } from './routes/dashboard';

export interface AppOptions {
  pushSender?: PushSender; // injectable for tests
}

export function createApp(pool: pg.Pool, cfg: AppConfig, opts: AppOptions = {}) {
  const app = express();
  const notifier = new Notifier(pool, opts.pushSender ?? createWebPushSender(cfg));
  app.locals.notifier = notifier;
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': cfg.cookieSecure ? [] : null,
        },
      },
      strictTransportSecurity: cfg.cookieSecure ? { maxAge: 15552000, includeSubDomains: false } : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  // health check (no auth) — used by Docker/orchestrator
  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/api', sessionLoader(pool, cfg), csrfGuard(cfg));
  app.use('/api/auth', authRoutes(pool, cfg));
  app.use('/api/users', requireAuth, userRoutes(pool));
  app.use('/api/portfolio', requireAuth, portfolioRoute(pool, cfg.timeZone));
  app.use('/api/notifications', requireAuth, notificationRoutes(pool, cfg, notifier));
  app.use('/api/projects', requireAuth, projectCollectionRoutes(pool));
  app.use('/api/directory', requireAuth, directoryRoutes(pool, cfg));

  const project = express.Router({ mergeParams: true });
  project.use('/budget', budgetRoutes(pool));
  project.use('/categories', categoryRoutes(pool));
  project.use('/payments', paymentRoutes(pool, cfg.timeZone));
  project.use('/contracts', contractRoutes(pool, cfg.timeZone));
  project.use('/prerequisites', prerequisiteRoutes(pool, cfg.timeZone));
  project.use('/materials', materialRoutes(pool, notifier, cfg.timeZone));
  project.use('/visits', visitRoutes(pool, notifier));
  project.use('/timeline', timelineRoutes(pool, notifier));
  project.use('/work-updates', workUpdateRoutes(pool));
  project.use('/attachments', attachmentRoutes(pool, cfg));
  project.use('/directory', projectDirectoryRoute(pool));
  project.use('/', dashboardRoutes(pool, cfg.timeZone));
  project.use('/', projectItemRoutes(pool));
  app.use('/api/projects/:projectId', requireAuth, projectScope(pool), project);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Serve the built SPA in production
  if (fs.existsSync(path.join(cfg.staticDir, 'index.html'))) {
    app.use(express.static(cfg.staticDir, {
      index: false,
      maxAge: '1h',
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === 'sw.js') {
          // the service worker must always be re-checked so updates roll out promptly
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Service-Worker-Allowed', '/');
        } else if (base === 'manifest.webmanifest') {
          res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // content-hashed file names
        }
      },
    }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(cfg.staticDir, 'index.html'));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // A file preview opens in its own tab: show a readable page instead of raw JSON.
    if (err instanceof HttpError && isFilePreviewNavigation(req)) {
      return res.status(err.status).set(PREVIEW_ERROR_HEADERS).send(previewErrorPage(err.status));
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    const e = err as { type?: string; code?: string; status?: number; message?: string };
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (e?.code === '23505') return res.status(409).json({ error: 'A record with the same unique value already exists' });
    if (e?.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist' });
    if (e?.code === '22P02' || e?.code === '22007' || e?.code === '22008') return res.status(400).json({ error: 'Invalid value' });
    if (cfg.nodeEnv !== 'test') console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

const PREVIEW_PATH = /^\/api\/(projects\/[^/]+\/attachments|directory\/[^/]+\/documents)\/[^/]+\/download$/;
function isFilePreviewNavigation(req: Request): boolean {
  return req.method === 'GET' && req.query.inline === '1' && PREVIEW_PATH.test(req.path) && req.accepts(['json', 'html']) === 'html';
}
const PREVIEW_ERROR_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
function previewErrorPage(status: number): string {
  const [title, text] = status === 401
    ? ['Sign in to view this file', 'Your session has ended. Sign in to Qonnect again, then open the file from its record.']
    : status === 403
      ? ['You can’t view this file', 'Your account doesn’t have access to this file.']
      : ['File not available', 'This file may have been archived, or it is missing from storage. Return to Qonnect and check the record.'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Qonnect</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;font-family:system-ui,sans-serif}
main{max-width:420px;margin:24px;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;text-align:center}
h1{font-size:18px;margin:0 0 6px}p{font-size:14px;color:#475569;line-height:1.5;margin:0 0 18px}
a{display:inline-block;padding:10px 18px;border-radius:10px;background:#0284c7;color:#fff;font-weight:600;font-size:14px;text-decoration:none}</style></head>
<body><main><h1>${title}</h1><p>${text}</p><a href="/">Open Qonnect</a></main></body></html>`;
}
