// /api/notifications — each user sees and manages ONLY their own notifications,
// preferences and push subscriptions. All writes are authenticated + CSRF-protected
// (global csrfGuard) and rate limited.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config';
import { badRequest, HttpError, notFound, parseBody, uuidParam } from '../lib/http';
import { audit } from '../audit';
import { NOTIFICATION_EVENT_TYPES } from '../../shared/constants';
import { validateSubscription } from '../notify/push';
import type { Notifier } from '../notify/notifier';

/** Small in-memory sliding-window limiter keyed by user. */
export function userRateLimit(max: number, windowMs: number, name: string) {
  const hits = new Map<string, number[]>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${name}:${req.user?.id ?? req.ip}`;
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return next(new HttpError(429, 'Too many requests — please wait a moment and try again.'));
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

const DEFAULT_EVENTS = [...NOTIFICATION_EVENT_TYPES];

const subscriptionSchema = z.object({
  endpoint: z.string().trim().min(10).max(1000),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().trim().min(20).max(200), auth: z.string().trim().min(10).max(100) }),
});

async function loadPrefs(pool: pg.Pool, userId: string) {
  const { rows } = await pool.query('SELECT push_enabled, event_types FROM notification_preferences WHERE user_id = $1', [userId]);
  const mutes = await pool.query('SELECT project_id FROM notification_project_mutes WHERE user_id = $1', [userId]);
  return {
    push_enabled: rows[0]?.push_enabled ?? false,
    event_types: (rows[0]?.event_types as string[] | undefined) ?? DEFAULT_EVENTS,
    muted_project_ids: mutes.rows.map((r) => r.project_id as string),
  };
}

export function notificationRoutes(pool: pg.Pool, cfg: AppConfig, notifier: Notifier) {
  const r = Router();
  const writeLimit = userRateLimit(30, 60_000, 'notif-write');

  // ---- push configuration (public VAPID key only)
  r.get('/push-config', (_req, res) => {
    res.json({ configured: notifier.pushConfigured, publicKey: notifier.publicKey });
  });

  // ---- in-app notification list (own, and only for projects the user can still access)
  r.get('/', async (req, res) => {
    const u = req.user!;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const accessible = `(n.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1) OR $2)`;
    const [list, unread] = await Promise.all([
      pool.query(
        `SELECT n.id, n.project_id, p.code AS project_code, n.kind, n.event_type, n.title, n.body, n.url, n.read_at, n.created_at
           FROM notifications n JOIN projects p ON p.id = n.project_id AND p.archived_at IS NULL
          WHERE n.user_id = $1 AND ${accessible}
          ORDER BY n.created_at DESC LIMIT $3`,
        [u.id, u.role === 'admin', limit],
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM notifications n JOIN projects p ON p.id = n.project_id AND p.archived_at IS NULL
          WHERE n.user_id = $1 AND n.read_at IS NULL AND ${accessible}`,
        [u.id, u.role === 'admin'],
      ),
    ]);
    res.json({ items: list.rows, unread: unread.rows[0].n });
  });

  r.post('/read-all', writeLimit, async (req, res) => {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
    res.json({ ok: true });
  });

  r.post('/:id/read', writeLimit, async (req, res) => {
    const id = uuidParam(req, 'id');
    const { rowCount } = await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    if (!rowCount) throw notFound();
    res.json({ ok: true });
  });

  // ---- preferences
  r.get('/preferences', async (req, res) => {
    res.json(await loadPrefs(pool, req.user!.id));
  });

  r.put('/preferences', writeLimit, async (req, res) => {
    const body = parseBody(z.object({
      push_enabled: z.boolean().optional(),
      event_types: z.array(z.enum(NOTIFICATION_EVENT_TYPES)).max(20).optional(),
      muted_project_ids: z.array(z.string().uuid()).max(500).optional(),
    }), req);
    const u = req.user!;
    const current = await loadPrefs(pool, u.id);
    const pushEnabled = body.push_enabled ?? current.push_enabled;
    const events = body.event_types ? [...new Set(body.event_types)] : current.event_types;
    await pool.query(
      `INSERT INTO notification_preferences (user_id, push_enabled, event_types) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET push_enabled = EXCLUDED.push_enabled, event_types = EXCLUDED.event_types, updated_at = now()`,
      [u.id, pushEnabled, events],
    );
    if (body.muted_project_ids) {
      // only projects the user can access may be muted
      const { rows } = await pool.query(
        u.role === 'admin'
          ? 'SELECT id FROM projects WHERE id = ANY($1::uuid[])'
          : 'SELECT project_id AS id FROM project_members WHERE user_id = $2 AND project_id = ANY($1::uuid[])',
        u.role === 'admin' ? [body.muted_project_ids] : [body.muted_project_ids, u.id],
      );
      await pool.query('DELETE FROM notification_project_mutes WHERE user_id = $1', [u.id]);
      for (const row of rows) await pool.query('INSERT INTO notification_project_mutes (user_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, row.id]);
    }
    res.json(await loadPrefs(pool, u.id));
  });

  // ---- push subscriptions (own devices only; keys are never returned)
  r.get('/subscriptions', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, user_agent, created_at, last_success_at, failure_count FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id],
    );
    res.json(rows);
  });

  r.post('/subscriptions', writeLimit, async (req, res) => {
    if (!notifier.pushConfigured) throw new HttpError(503, 'Push notifications are not configured on this server yet.');
    const body = parseBody(subscriptionSchema, req);
    const problem = validateSubscription(cfg, body);
    if (problem) throw badRequest(problem);
    const u = req.user!;
    // A browser subscription is a secret capability held by the device. If the same browser was
    // previously subscribed for another account (shared device, re-login), possession of the
    // endpoint + keys transfers it to the signed-in user; it can never be read back by anyone.
    const { rows } = await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, expiration_time, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             expiration_time = EXCLUDED.expiration_time, user_agent = EXCLUDED.user_agent,
             failure_count = 0, updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [u.id, body.endpoint, body.keys.p256dh, body.keys.auth,
        body.expirationTime ? new Date(body.expirationTime) : null, (req.get('user-agent') ?? '').slice(0, 200)],
    );
    await pool.query(
      `INSERT INTO notification_preferences (user_id, push_enabled) VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET push_enabled = true, updated_at = now()`,
      [u.id],
    );
    await audit(pool, req, { projectId: null, action: rows[0].inserted ? 'create' : 'update', entityType: 'push_subscription', entityId: rows[0].id, summary: 'Enabled push notifications on a device' });
    res.status(rows[0].inserted ? 201 : 200).json({ id: rows[0].id });
  });

  /** Remove the current device's subscription by endpoint (own only). */
  r.post('/subscriptions/remove', writeLimit, async (req, res) => {
    const { endpoint } = parseBody(z.object({ endpoint: z.string().trim().min(10).max(1000) }), req);
    const { rows } = await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2 RETURNING id', [endpoint, req.user!.id]);
    if (rows[0]) await audit(pool, req, { projectId: null, action: 'delete', entityType: 'push_subscription', entityId: rows[0].id, summary: 'Removed push notifications from this device' });
    res.json({ ok: true, removed: rows.length });
  });

  r.delete('/subscriptions/:id', writeLimit, async (req, res) => {
    const id = uuidParam(req, 'id');
    const { rowCount } = await pool.query('DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
    if (!rowCount) throw notFound();
    await audit(pool, req, { projectId: null, action: 'delete', entityType: 'push_subscription', entityId: id, summary: 'Removed a push notification device' });
    res.json({ ok: true });
  });

  /** Sends a test push to the caller's own devices. */
  r.post('/test', userRateLimit(3, 60_000, 'notif-test'), async (req, res) => {
    if (!notifier.pushConfigured) throw new HttpError(503, 'Push notifications are not configured on this server yet.');
    const status = await notifier.deliver(null, req.user!.id,
      { title: 'Qonnect', body: 'Test notification — push is working on this device.', url: '/#/notifications', tag: `test-${req.user!.id}` },
      `test:${req.user!.id}:${Date.now()}`);
    res.json({ status });
  });

  return r;
}
