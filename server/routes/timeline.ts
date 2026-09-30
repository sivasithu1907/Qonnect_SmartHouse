import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, forbidden, HttpError, parseBody, parsePatch, uuidParam, zDate, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { can } from '../permissions';
import { TASK_STATUSES } from '../../shared/constants';

export async function loadTimeline(db: pg.Pool | pg.PoolClient, projectId: string, includeArchived = false) {
  const [ph, tk, dp] = await Promise.all([
    db.query('SELECT * FROM timeline_phases WHERE project_id = $1 AND ($2 OR archived_at IS NULL) ORDER BY seq, created_at', [projectId, includeArchived]),
    db.query('SELECT * FROM timeline_tasks WHERE project_id = $1 AND ($2 OR archived_at IS NULL) ORDER BY sort_order, created_at', [projectId, includeArchived]),
    db.query('SELECT task_id, depends_on_task_id FROM task_dependencies WHERE project_id = $1', [projectId]),
  ]);
  const deps = new Map<string, string[]>();
  for (const d of dp.rows) deps.set(d.task_id, [...(deps.get(d.task_id) ?? []), d.depends_on_task_id]);
  return { phases: ph.rows, tasks: tk.rows.map((t) => ({ ...t, depends_on: deps.get(t.id) ?? [] })) };
}

const phaseSchema = z.object({
  seq: z.number().int().min(1).max(1000).optional(),
  name: zText(300).min(1),
  description: zText(2000).default(''),
  planned_start: zDate.optional(),
  planned_end: zDate.optional(),
  actual_start: zDate.optional(),
  actual_end: zDate.optional(),
  schedule_approved: z.boolean().optional(),
  notes: zText(4000).default(''),
});

const taskSchema = z.object({
  phase_id: z.string().uuid(),
  name: zText(300).min(1),
  description: zText(2000).default(''),
  is_hold_point: z.boolean().default(false),
  planned_start: zDate.optional(),
  planned_end: zDate.optional(),
  actual_start: zDate.optional(),
  actual_end: zDate.optional(),
  status: z.enum(TASK_STATUSES).default('Not Scheduled'),
  responsible: zText(200).default(''),
  notes: zText(4000).default(''),
  sort_order: z.number().int().min(0).max(10000).optional(),
  depends_on: z.array(z.string().uuid()).max(50).optional(),
  override_dependencies: z.boolean().optional(),
});

async function setDependencies(c: pg.PoolClient, pid: string, taskId: string, deps: string[]) {
  const unique = [...new Set(deps)];
  if (unique.includes(taskId)) throw badRequest('A task cannot depend on itself');
  for (const d of unique) await assertSameProject(c, 'timeline_tasks', pid, d, 'Dependency task');
  // cycle check: none of the new dependencies may (transitively) depend on this task
  const { rows } = await c.query(
    `WITH RECURSIVE up(id) AS (
        SELECT unnest($2::uuid[])
        UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN up ON d.task_id = up.id WHERE d.project_id = $1)
     SELECT 1 FROM up WHERE id = $3 LIMIT 1`,
    [pid, unique, taskId],
  );
  if (rows.length) throw badRequest('This dependency would create a circular sequence');
  await c.query('DELETE FROM task_dependencies WHERE task_id = $1 AND project_id = $2', [taskId, pid]);
  for (const d of unique) await c.query('INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES ($1,$2,$3)', [pid, taskId, d]);
}

async function openDependencies(c: pg.PoolClient, pid: string, taskId: string): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT t.name FROM task_dependencies d JOIN timeline_tasks t ON t.id = d.depends_on_task_id
      WHERE d.task_id = $1 AND d.project_id = $2 AND t.status <> 'Completed' AND t.archived_at IS NULL`,
    [taskId, pid],
  );
  return rows.map((r) => r.name);
}

export function timelineRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'timeline.read');
    res.json(await loadTimeline(pool, req.project!.id, req.query.includeArchived === '1'));
  });

  r.post('/phases', async (req, res) => {
    assertCap(req, 'timeline.write');
    const body = parseBody(phaseSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      if (body.seq === undefined) {
        const { rows } = await c.query('SELECT COALESCE(MAX(seq),0)+1 AS n FROM timeline_phases WHERE project_id = $1', [pid]);
        body.seq = rows[0].n;
      }
      const p = await insertRow(c, 'timeline_phases', { ...body, project_id: pid });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'timeline_phase', entityId: p.id as string, summary: `Added phase ${body.name}`, after: p });
      return p;
    });
    res.status(201).json(row);
  });

  r.patch('/phases/:id', async (req, res) => {
    assertCap(req, 'timeline.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(phaseSchema.partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const { before, after } = await patchOwned(c, 'timeline_phases', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, {
        projectId: pid, action: body.schedule_approved && !before.schedule_approved ? 'approve' : 'update',
        entityType: 'timeline_phase', entityId: id, summary: `Edited phase ${after.name} (${d.changed.join(', ')})`, before: d.before, after: d.after,
      });
      return after;
    });
    res.json(out);
  });

  r.post('/tasks', async (req, res) => {
    assertCap(req, 'timeline.write');
    const body = parseBody(taskSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertSameProject(c, 'timeline_phases', pid, body.phase_id, 'Phase');
      if (body.status === 'Completed') throw badRequest('Create the task first, then mark it completed with an actual completion date');
      const { depends_on, override_dependencies: _o, ...data } = body;
      const t = await insertRow(c, 'timeline_tasks', { ...data, project_id: pid });
      if (depends_on?.length) await setDependencies(c, pid, t.id as string, depends_on);
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'timeline_task', entityId: t.id as string, summary: `Added task ${body.name}`, after: { ...t, depends_on } });
      return t;
    });
    res.status(201).json(row);
  });

  r.patch('/tasks/:id', async (req, res) => {
    assertCap(req, 'timeline.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(taskSchema.partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, unknown>>(c, 'timeline_tasks', pid, id);
      if (body.phase_id) await assertSameProject(c, 'timeline_phases', pid, body.phase_id, 'Phase');
      const { depends_on, override_dependencies, ...data } = body;
      if (depends_on) await setDependencies(c, pid, id, depends_on);
      const nextStatus = data.status ?? cur.status;
      const nextEnd = data.actual_end !== undefined ? data.actual_end : cur.actual_end;
      if (nextStatus === 'Completed') {
        if (!nextEnd) throw badRequest('Enter the actual completion date to mark this task completed');
        if (cur.status !== 'Completed') {
          const open = await openDependencies(c, pid, id);
          if (open.length && !override_dependencies) {
            throw new HttpError(409, `Predecessor tasks are not completed: ${open.join('; ')}`, { code: 'DEPENDENCIES_OPEN', open });
          }
        }
      }
      const { before, after } = await patchOwned(c, 'timeline_tasks', pid, id, data);
      const d = diff(before, after);
      await audit(c, req, {
        projectId: pid, action: after.status === 'Completed' && before.status !== 'Completed' ? 'complete' : 'update',
        entityType: 'timeline_task', entityId: id,
        summary: `Edited task ${after.name} (${[...d.changed, ...(depends_on ? ['depends_on'] : [])].join(', ')})${override_dependencies ? ' — dependency check overridden' : ''}`,
        before: d.before, after: { ...d.after, ...(depends_on ? { depends_on } : {}) },
      });
      return after;
    });
    res.json(out);
  });

  for (const kind of ['phases', 'tasks'] as const) {
    for (const action of ['archive', 'restore'] as const) {
      r.post(`/${kind}/:id/${action}`, async (req, res) => {
        assertCap(req, 'timeline.write');
        const id = uuidParam(req, 'id');
        const pid = req.project!.id;
        const table = kind === 'phases' ? 'timeline_phases' : 'timeline_tasks';
        const out = await withTx(pool, async (c) => {
          const { after } = await patchOwned(c, table, pid, id, { archived_at: action === 'archive' ? new Date() : null });
          await audit(c, req, { projectId: pid, action, entityType: kind === 'phases' ? 'timeline_phase' : 'timeline_task', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} ${after.name}` });
          return after;
        });
        res.json(out);
      });
    }
  }

  return r;
}

// ============================================================ work updates
const workSchema = z.object({
  update_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: zText(300).min(1),
  description: zText(8000).default(''),
  related_task_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional(),
  related_material_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional(),
});

export function workUpdateRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'timeline.read');
    const { rows } = await pool.query(
      `SELECT w.*, u.name AS author_name,
              (SELECT count(*)::int FROM attachments a WHERE a.entity_type='work_update' AND a.entity_id=w.id AND a.archived_at IS NULL) AS attachment_count
         FROM work_updates w LEFT JOIN users u ON u.id = w.author_id
        WHERE w.project_id = $1 AND w.archived_at IS NULL ORDER BY w.update_date DESC, w.created_at DESC`,
      [req.project!.id],
    );
    res.json(rows);
  });

  r.post('/', async (req, res) => {
    assertCap(req, 'workupdates.write');
    const body = parseBody(workSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertSameProject(c, 'timeline_tasks', pid, body.related_task_id, 'Related task');
      await assertSameProject(c, 'material_items', pid, body.related_material_id, 'Related material');
      const w = await insertRow(c, 'work_updates', { ...body, project_id: pid, author_id: req.user!.id });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'work_update', entityId: w.id as string, summary: `Work update: ${body.title}`, after: w });
      return w;
    });
    res.status(201).json(row);
  });

  r.patch('/:id', async (req, res) => {
    assertCap(req, 'workupdates.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(workSchema.partial().extend({ archived: z.boolean().optional() }), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<{ author_id: string }>(c, 'work_updates', pid, id);
      const isManager = can(req.user!.role, 'timeline.write');
      if (!isManager && cur.author_id !== req.user!.id) throw forbidden('You can only edit your own work updates');
      await assertSameProject(c, 'timeline_tasks', pid, body.related_task_id, 'Related task');
      await assertSameProject(c, 'material_items', pid, body.related_material_id, 'Related material');
      const { archived, ...rest } = body;
      const patch: Record<string, unknown> = { ...rest };
      if (archived !== undefined) patch.archived_at = archived ? new Date() : null;
      const { before, after } = await patchOwned(c, 'work_updates', pid, id, patch);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: archived ? 'archive' : 'update', entityType: 'work_update', entityId: id, summary: `Edited work update ${after.title}`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  return r;
}
