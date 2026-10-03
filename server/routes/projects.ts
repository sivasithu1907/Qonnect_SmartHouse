import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap, requireCap } from '../auth';
import { badRequest, conflict, parseBody, zDate, zMoney, zText, zUrl } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { applyBudgetStructure, applyContractCategories, applyTimelineTemplate } from '../seed/apply';
import { MISC_BASES } from '../../shared/constants';

export const normalizeCode = (code: string) => code.trim().replace(/\s+/g, ' ');

const linkFields = {
  drive_folder_url: zUrl,
  sheets_url: zUrl,
  payments_drive_url: zUrl,
  materials_drive_url: zUrl,
  consultant_drive_url: zUrl,
  site_visits_drive_url: zUrl,
};

const projectFields = {
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9 _./-]+$/, 'letters, digits, spaces and - _ . / only'),
  name: zText(160).min(1),
  location: zText(160).default(''),
  description: zText(4000).default(''),
  client: zText(160).default(''),
  status: zText(120).default('Setup'),
  planned_start_date: zDate.optional(),
  target_completion_date: zDate.optional(),
  notes: zText(4000).default(''),
};

async function codeTaken(db: pg.Pool | pg.PoolClient, code: string, exceptId?: string) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM projects WHERE upper(regexp_replace(code, '\\s+', ' ', 'g')) = upper($1) AND ($2::uuid IS NULL OR id <> $2)`,
    [normalizeCode(code), exceptId ?? null],
  );
  return !!rowCount;
}

/** Routes not bound to a single project: list + create. */
export function projectCollectionRoutes(pool: pg.Pool) {
  const r = Router();

  r.get('/', async (req, res) => {
    const u = req.user!;
    const includeArchived = req.query.includeArchived === '1' && u.role === 'admin';
    const { rows } = await pool.query(
      u.role === 'admin'
        ? `SELECT * FROM projects WHERE ($1 OR archived_at IS NULL) ORDER BY archived_at NULLS FIRST, created_at`
        : `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
            WHERE p.archived_at IS NULL ORDER BY p.created_at`,
      u.role === 'admin' ? [includeArchived] : [u.id],
    );
    res.json(rows);
  });

  const createSchema = z.object({
    ...projectFields,
    ...Object.fromEntries(Object.entries(linkFields).map(([k, v]) => [k, v.default('')])),
    misc_percentage: z.number().min(0).max(100).default(10),
    template: z.object({ budget: z.boolean().default(true), timeline: z.boolean().default(true) }).default({ budget: true, timeline: true }),
  });

  r.post('/', requireCap('projects.manage'), async (req, res) => {
    const body = parseBody(createSchema, req) as z.infer<typeof createSchema> & Record<string, string>;
    const code = normalizeCode(body.code);
    const project = await withTx(pool, async (c) => {
      if (await codeTaken(c, code)) throw conflict(`Project code "${code}" is already in use`);
      const { rows } = await c.query(
        `INSERT INTO projects (code, name, location, description, client, status, planned_start_date, target_completion_date, notes,
                               misc_percentage, drive_folder_url, sheets_url, payments_drive_url, materials_drive_url,
                               consultant_drive_url, site_visits_drive_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          code, body.name, body.location, body.description, body.client, body.status, body.planned_start_date ?? null,
          body.target_completion_date ?? null, body.notes, body.misc_percentage, body.drive_folder_url, body.sheets_url,
          body.payments_drive_url, body.materials_drive_url, body.consultant_drive_url, body.site_visits_drive_url, req.user!.id,
        ],
      );
      const p = rows[0];
      if (body.template.budget) await applyBudgetStructure(c, p.id);
      if (body.template.timeline) await applyTimelineTemplate(c, p.id);
      await applyContractCategories(c, p.id);
      await audit(c, req, { projectId: p.id, action: 'create', entityType: 'project', entityId: p.id, summary: `Created project ${p.name} — ${p.code}`, after: p });
      return p;
    });
    res.status(201).json(project);
  });

  return r;
}

/** Routes under /api/projects/:projectId (project already loaded + access-checked). */
export function projectItemRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', (req, res) => {
    res.json(req.project);
  });

  const editSchema = z.object({
    code: projectFields.code.optional(),
    name: projectFields.name.optional(),
    location: zText(160).optional(),
    description: zText(4000).optional(),
    client: zText(160).optional(),
    status: zText(120).optional(),
    planned_start_date: zDate.optional(),
    target_completion_date: zDate.optional(),
    notes: zText(4000).optional(),
  });

  r.patch('/', requireCap('projects.manage'), async (req, res) => {
    const body = parseBody(editSchema, req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      if (body.code) {
        body.code = normalizeCode(body.code);
        if (await codeTaken(c, body.code, pid)) throw conflict(`Project code "${body.code}" is already in use`);
      }
      const before = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      const keys = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
      if (!keys.length) return before;
      const { rows } = await c.query(
        `UPDATE projects SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [pid, ...keys.map((k) => (body as Record<string, unknown>)[k])],
      );
      const d = diff(before, rows[0]);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'project', entityId: pid, summary: `Edited project (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return rows[0];
    });
    res.json(out);
  });

  r.patch('/links', async (req, res) => {
    assertCap(req, 'links.edit');
    const body = parseBody(z.object(Object.fromEntries(Object.entries(linkFields).map(([k, v]) => [k, v.optional()]))), req) as Record<string, string | undefined>;
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const before = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      const keys = Object.keys(body).filter((k) => body[k] !== undefined && k in linkFields);
      if (!keys.length) return before;
      const { rows } = await c.query(
        `UPDATE projects SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [pid, ...keys.map((k) => body[k])],
      );
      const d = diff(before, rows[0]);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'project_links', entityId: pid, summary: `Updated links (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return rows[0];
    });
    res.json(out);
  });

  const settingsSchema = z.object({
    misc_percentage: z.number().min(0).max(100).optional(),
    misc_basis: z.enum(MISC_BASES).optional(),
    control_budget: zMoney.optional(),
    control_budget_confirmed: z.boolean().optional(),
  });

  r.patch('/settings', requireCap('projects.manage'), async (req, res) => {
    const body = parseBody(settingsSchema, req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const before = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [pid])).rows[0];
      const budget = body.control_budget !== undefined ? body.control_budget : before.control_budget;
      let confirmed = body.control_budget_confirmed ?? before.control_budget_confirmed;
      if (body.control_budget !== undefined && body.control_budget !== before.control_budget && body.control_budget_confirmed === undefined) {
        confirmed = false; // changing the amount clears confirmation unless re-confirmed explicitly
      }
      if (confirmed && (budget === null || budget === undefined)) throw badRequest('Enter a control budget amount before confirming it');
      const becameConfirmed = confirmed && !before.control_budget_confirmed;
      const { rows } = await c.query(
        `UPDATE projects SET misc_percentage = $2, misc_basis = $3, control_budget = $4, control_budget_confirmed = $5,
                control_budget_confirmed_by = CASE WHEN $5 THEN (CASE WHEN $6 THEN $7::uuid ELSE control_budget_confirmed_by END) ELSE NULL END,
                control_budget_confirmed_at = CASE WHEN $5 THEN (CASE WHEN $6 THEN now() ELSE control_budget_confirmed_at END) ELSE NULL END,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [pid, body.misc_percentage ?? before.misc_percentage, body.misc_basis ?? before.misc_basis, budget, confirmed, becameConfirmed, req.user!.id],
      );
      const d = diff(before, rows[0]);
      await audit(c, req, {
        projectId: pid, action: becameConfirmed ? 'approve' : 'update', entityType: 'project_settings', entityId: pid,
        summary: becameConfirmed ? 'Confirmed control budget' : `Updated project budget settings (${d.changed.join(', ')})`,
        before: d.before, after: d.after,
      });
      return rows[0];
    });
    res.json(out);
  });

  r.post('/archive', requireCap('projects.manage'), async (req, res) => {
    const pid = req.project!.id;
    if (req.project!.archived_at) throw badRequest('Project is already archived');
    const out = await withTx(pool, async (c) => {
      const { rows } = await c.query('UPDATE projects SET archived_at = now(), archived_by = $2, updated_at = now() WHERE id = $1 RETURNING *', [pid, req.user!.id]);
      await audit(c, req, { projectId: pid, action: 'archive', entityType: 'project', entityId: pid, summary: `Archived project ${rows[0].code}` });
      return rows[0];
    });
    res.json(out);
  });

  r.post('/restore', requireCap('projects.manage'), async (req, res) => {
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const { rows } = await c.query('UPDATE projects SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = $1 RETURNING *', [pid]);
      await audit(c, req, { projectId: pid, action: 'restore', entityType: 'project', entityId: pid, summary: `Restored project ${rows[0].code}` });
      return rows[0];
    });
    res.json(out);
  });

  /** Members of the project, for assignment pickers (names and roles only). */
  r.get('/members', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.role FROM users u
         JOIN project_members m ON m.user_id = u.id AND m.project_id = $1
        WHERE u.is_active ORDER BY u.name`,
      [req.project!.id],
    );
    res.json(rows);
  });

  r.get('/audit', async (req, res) => {
    assertCap(req, 'audit.read');
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const { rows } = await pool.query(
      `SELECT id, action, entity_type, entity_id, summary, before, after, user_email, created_at
         FROM audit_log WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [req.project!.id, limit],
    );
    res.json(rows);
  });

  return r;
}
