import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { requireCap } from '../auth';
import { ROLES } from '../../shared/constants';
import { badRequest, conflict, notFound, parseBody, uuidParam } from '../lib/http';
import { hashPassword, passwordProblems } from '../lib/passwords';
import { withTx } from '../db';
import { audit } from '../audit';

const USER_COLS = 'id, email, name, role, is_active, last_login_at, locked_until, created_at';

export function userRoutes(pool: pg.Pool) {
  const r = Router();
  r.use(requireCap('users.manage'));

  r.get('/', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT ${USER_COLS.split(', ').map((c) => 'u.' + c).join(', ')},
              COALESCE(array_agg(m.project_id) FILTER (WHERE m.project_id IS NOT NULL), '{}') AS project_ids
         FROM users u LEFT JOIN project_members m ON m.user_id = u.id
        GROUP BY u.id ORDER BY u.is_active DESC, u.name`,
    );
    res.json(rows);
  });

  const createSchema = z.object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(1).max(120),
    role: z.enum(ROLES),
    password: z.string().max(200),
    projectIds: z.array(z.string().uuid()).max(200).default([]),
  });

  r.post('/', async (req, res) => {
    const body = parseBody(createSchema, req);
    const problem = passwordProblems(body.password);
    if (problem) throw badRequest(problem);
    const hash = await hashPassword(body.password);
    const user = await withTx(pool, async (c) => {
      const dup = await c.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [body.email]);
      if (dup.rowCount) throw conflict('A user with this email already exists');
      const { rows } = await c.query(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING ${USER_COLS}`,
        [body.email, body.name, body.role, hash],
      );
      for (const pid of body.projectIds) {
        await c.query('INSERT INTO project_members (project_id, user_id) SELECT id, $2 FROM projects WHERE id = $1 ON CONFLICT DO NOTHING', [pid, rows[0].id]);
      }
      await audit(c, req, { projectId: null, action: 'create', entityType: 'user', entityId: rows[0].id, summary: `Created user ${body.email} (${body.role})`, after: { ...rows[0], projectIds: body.projectIds } });
      return rows[0];
    });
    res.status(201).json(user);
  });

  const updateSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
    password: z.string().max(200).optional(),
    projectIds: z.array(z.string().uuid()).max(200).optional(),
    unlock: z.boolean().optional(),
  });

  r.patch('/:id', async (req, res) => {
    const id = uuidParam(req, 'id');
    const body = parseBody(updateSchema, req);
    if (id === req.user!.id && (body.role && body.role !== 'admin' || body.isActive === false)) {
      throw badRequest('You cannot remove your own admin role or deactivate yourself');
    }
    let hash: string | null = null;
    if (body.password) {
      const problem = passwordProblems(body.password);
      if (problem) throw badRequest(problem);
      hash = await hashPassword(body.password);
    }
    const out = await withTx(pool, async (c) => {
      const before = (await c.query(`SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw notFound('User not found');
      const { rows } = await c.query(
        `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), is_active = COALESCE($4, is_active),
                password_hash = COALESCE($5, password_hash),
                failed_logins = CASE WHEN $6 THEN 0 ELSE failed_logins END,
                locked_until = CASE WHEN $6 THEN NULL ELSE locked_until END,
                updated_at = now()
          WHERE id = $1 RETURNING ${USER_COLS}`,
        [id, body.name ?? null, body.role ?? null, body.isActive ?? null, hash, body.unlock === true || !!hash],
      );
      if (hash || body.isActive === false || (body.role && body.role !== before.role)) {
        await c.query('DELETE FROM sessions WHERE user_id = $1', [id]); // force re-login
      }
      if (body.projectIds) {
        await c.query('DELETE FROM project_members WHERE user_id = $1', [id]);
        for (const pid of body.projectIds) {
          await c.query('INSERT INTO project_members (project_id, user_id) SELECT id, $2 FROM projects WHERE id = $1 ON CONFLICT DO NOTHING', [pid, id]);
        }
      }
      await audit(c, req, {
        projectId: null, action: 'update', entityType: 'user', entityId: id,
        summary: `Updated user ${before.email}${hash ? ' (password reset)' : ''}`,
        before, after: { ...rows[0], projectIds: body.projectIds },
      });
      return rows[0];
    });
    res.json(out);
  });

  return r;
}
