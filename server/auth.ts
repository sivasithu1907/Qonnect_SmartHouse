// Session authentication (opaque random token in an HttpOnly cookie; only its
// SHA-256 is stored), CSRF token checks, login throttling and project access.
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import type { AppConfig } from './config';
import type { AuthUser } from './types';
import { forbidden, HttpError, notFound } from './lib/http';
import { can, type Capability } from './permissions';

export const SESSION_COOKIE = 'sh_session';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(pool: pg.Pool, cfg: AppConfig, userId: string, req: Request, res: Response) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + cfg.sessionTtlHours * 3600_000);
  await pool.query(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256(token), userId, csrf, expires, req.ip ?? null, (req.get('user-agent') ?? '').slice(0, 300)],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'strict',
    path: '/',
    expires,
  });
  return csrf;
}

export async function destroySession(pool: pg.Pool, sessionId: string | undefined, res: Response, cfg: AppConfig) {
  if (sessionId) await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict', path: '/' });
}

/** Loads the session (if any) and attaches req.user. Never rejects by itself. */
export function sessionLoader(pool: pg.Pool, cfg: AppConfig) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 20 && token.length < 200) {
      const id = sha256(token);
      const { rows } = await pool.query(
        `SELECT s.id, s.csrf_token, s.last_seen, u.id AS user_id, u.email, u.name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
        [id],
      );
      if (rows[0]) {
        const r = rows[0];
        req.sessionId = r.id;
        req.csrfToken = r.csrf_token;
        req.user = { id: r.user_id, email: r.email, name: r.name, role: r.role } satisfies AuthUser;
        // sliding expiry, written at most once every 5 minutes
        if (Date.now() - new Date(r.last_seen).getTime() > 5 * 60_000) {
          await pool.query(
            `UPDATE sessions SET last_seen = now(), expires_at = now() + ($2 || ' hours')::interval WHERE id = $1`,
            [id, String(cfg.sessionTtlHours)],
          );
        }
      }
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

/** Double-submit style CSRF check for state-changing requests (token issued per session). */
export function csrfGuard(cfg: AppConfig) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (cfg.appOrigin) {
      const origin = req.get('origin');
      if (origin && origin.replace(/\/$/, '') !== cfg.appOrigin) return next(forbidden('Cross-origin request rejected'));
    }
    if (!req.user) return next(); // unauthenticated requests are rejected by requireAuth
    const sent = req.get('x-csrf-token') ?? '';
    const expected = req.csrfToken ?? '';
    if (!sent || sent.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
      return next(forbidden('Invalid or missing CSRF token'));
    }
    next();
  };
}

export function requireCap(cap: Capability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!can(req.user.role, cap)) return next(forbidden());
    next();
  };
}

export function assertCap(req: Request, cap: Capability) {
  if (!req.user || !can(req.user.role, cap)) throw forbidden();
}

/**
 * Loads :projectId and verifies the user may access it (admins: all projects;
 * others: assigned, non-archived projects). Unknown or inaccessible → 404 so
 * project existence is not leaked.
 */
export function projectScope(pool: pg.Pool) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user!;
    const pid = req.params.projectId;
    if (typeof pid !== 'string' || !/^[0-9a-f-]{36}$/i.test(pid)) return next(notFound('Project not found'));
    const { rows } = await pool.query(
      user.role === 'admin'
        ? 'SELECT * FROM projects WHERE id = $1'
        : `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
            WHERE p.id = $1 AND p.archived_at IS NULL`,
      user.role === 'admin' ? [pid] : [pid, user.id],
    );
    if (!rows[0]) return next(notFound('Project not found'));
    req.project = rows[0];
    // Archived projects are read-only, except for the restore endpoint.
    if (rows[0].archived_at && !['GET', 'HEAD'].includes(req.method) && !req.path.endsWith('/restore')) {
      return next(new HttpError(409, 'This project is archived. Restore it before making changes.'));
    }
    next();
  };
}

// ---------- simple in-memory login throttle (per IP) in addition to per-account lockout
const attempts = new Map<string, { count: number; first: number }>();
export function loginThrottle(req: Request, _res: Response, next: NextFunction) {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const WINDOW = 15 * 60_000;
  const rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW) {
    attempts.set(key, { count: 1, first: now });
    return next();
  }
  rec.count++;
  if (rec.count > 30) return next(new HttpError(429, 'Too many login attempts. Try again later.'));
  next();
}
export function resetLoginThrottle() {
  attempts.clear();
}
