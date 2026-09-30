import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config';
import { createSession, destroySession, loginThrottle, requireAuth } from '../auth';
import { HttpError, parseBody, badRequest } from '../lib/http';
import { hashPassword, passwordProblems, verifyPassword } from '../lib/passwords';
import { capabilitiesFor } from '../permissions';
import { audit } from '../audit';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// used to equalise timing when the email is unknown
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export function authRoutes(pool: pg.Pool, cfg: AppConfig) {
  const r = Router();

  r.post('/login', loginThrottle, async (req, res) => {
    if (!req.is('application/json')) throw badRequest('Expected JSON');
    const { email, password } = parseBody(
      z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) }),
      req,
    );
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    const u = rows[0];
    if (u?.locked_until && new Date(u.locked_until) > new Date()) {
      throw new HttpError(429, 'Account temporarily locked after repeated failed logins. Try again later.');
    }
    const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || !u.is_active) {
      if (u) {
        await pool.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
           WHERE id = $1`,
          [u.id, MAX_FAILED, String(LOCK_MINUTES)],
        );
      }
      throw new HttpError(401, 'Invalid email or password');
    }
    await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
    // rotate: remove any session presented with this request
    if (req.sessionId) await pool.query('DELETE FROM sessions WHERE id = $1', [req.sessionId]);
    const csrf = await createSession(pool, cfg, u.id, req, res);
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
    await audit(pool, req, { projectId: null, action: 'login', entityType: 'user', entityId: u.id, summary: 'Signed in' });
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role }, csrfToken: csrf, capabilities: capabilitiesFor(u.role) });
  });

  r.post('/logout', async (req, res) => {
    await destroySession(pool, req.sessionId, res, cfg);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, async (req, res) => {
    const u = req.user!;
    res.json({ user: u, csrfToken: req.csrfToken, capabilities: capabilitiesFor(u.role) });
  });

  r.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = parseBody(
      z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }),
      req,
    );
    const problem = passwordProblems(newPassword);
    if (problem) throw badRequest(problem);
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) throw badRequest('Current password is incorrect');
    await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user!.id, await hashPassword(newPassword)]);
    // sign out all other sessions
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user!.id, req.sessionId]);
    await audit(pool, req, { projectId: null, action: 'update', entityType: 'user', entityId: req.user!.id, summary: 'Changed own password' });
    res.json({ ok: true });
  });

  return r;
}
