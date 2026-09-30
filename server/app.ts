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

  const project = express.Router({ mergeParams: true });
  project.use('/budget', budgetRoutes(pool));
  project.use('/categories', categoryRoutes(pool));
  project.use('/payments', paymentRoutes(pool, cfg.timeZone));
  project.use('/materials', materialRoutes(pool, notifier));
  project.use('/visits', visitRoutes(pool, notifier));
  project.use('/timeline', timelineRoutes(pool, notifier));
  project.use('/work-updates', workUpdateRoutes(pool));
  project.use('/attachments', attachmentRoutes(pool, cfg));
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
