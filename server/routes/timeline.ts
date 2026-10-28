import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, forbidden, HttpError, parseBody, parsePatch, uuidParam, zDate, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertProjectMember, assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { can } from '../permissions';
import { TASK_STATUSES } from '../../shared/constants';
import { todayISO } from '../../shared/calc';
import type { Notifier } from '../notify/notifier';
import { taskAssignedEvents } from '../notify/events';
import { avatarVersionSql } from './avatars';
import { checkDirectoryLinks, directoryJoin, directoryLinkFields, directorySelect } from '../lib/directoryLinks';

export async function loadTimeline(db: pg.Pool | pg.PoolClient, projectId: string, includeArchived = false) {
  const [ph, tk, dp] = await Promise.all([
    db.query('SELECT * FROM timeline_phases WHERE project_id = $1 AND ($2 OR archived_at IS NULL) ORDER BY seq, created_at', [projectId, includeArchived]),
    db.query(
      `SELECT t.*, u.name AS assigned_user_name, ${avatarVersionSql('u')} AS assigned_user_avatar_version, cu.name AS completion_recorded_by_name, ${directorySelect('t')} FROM timeline_tasks t LEFT JOIN users u ON u.id = t.assigned_user_id
         LEFT JOIN users cu ON cu.id = t.completion_recorded_by ${directoryJoin('t')}
        WHERE t.project_id = $1 AND ($2 OR t.archived_at IS NULL) ORDER BY t.sort_order, t.created_at`,
      [projectId, includeArchived],
    ),
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
  assigned_user_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional(),
  notes: zText(4000).default(''),
  sort_order: z.number().int().min(0).max(10000).optional(),
  depends_on: z.array(z.string().uuid()).max(50).optional(),
  override_dependencies: z.boolean().optional(),
  ...directoryLinkFields,
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

const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : '');

/** Actual dates may be historical (before the record existed) but never in the future, and start ≤ finish. */
export function assertActualDates(start: string | Date | null, end: string | Date | null, today: string, changed: boolean) {
  if (!changed) return;
  const s = iso(start), e = iso(end);
  if (e && e > today) throw badRequest('The actual completion date cannot be in the future');
  if (s && s > today) throw badRequest('The actual start date cannot be in the future');
  if (s && e && s > e) throw badRequest('The actual start date is after the actual completion date');
}

/**
 * Reasons a task should not be completed without an explicit explanation: open predecessors (other than tasks
 * completed in the same action), an inspection hold point (no inspection is approved automatically), or a blocked /
 * on-hold status. The reason given is recorded in the audit history.
 */
async function completionIssues(c: pg.PoolClient, pid: string, t: Record<string, any>, together: Set<string>) {
  const out: Array<{ code: string; message: string }> = [];
  const { rows } = await c.query(
    `SELECT dt.id, dt.name FROM task_dependencies d JOIN timeline_tasks dt ON dt.id = d.depends_on_task_id
      WHERE d.task_id = $1 AND d.project_id = $2 AND dt.status <> 'Completed' AND dt.archived_at IS NULL`, [t.id, pid]);
  const open = rows.filter((r) => !together.has(r.id));
  if (open.length) out.push({ code: 'dependencies', message: `Predecessors not completed: ${open.map((r) => r.name).join('; ')}` });
  if (t.is_hold_point) out.push({ code: 'hold_point', message: 'Inspection / hold point — completing it does not record an inspection approval' });
  if (t.status === 'Blocked' || t.status === 'On Hold') out.push({ code: 'blocked', message: `Currently ${String(t.status).toLowerCase()}` });
  return out;
}

function completionPatch(cur: Record<string, any>, b: { actual_end?: string | null; actual_start?: string | null; date_unknown: boolean; note: string; historical: boolean }, userId: string, start: string | null) {
  return {
    status: 'Completed', actual_end: b.date_unknown ? null : b.actual_end ?? null, actual_start: start ?? cur.actual_start ?? null,
    completion_date_unknown: b.date_unknown, completion_note: b.note.trim(), completion_recorded_at: new Date(), completion_recorded_by: userId,
    completion_historical: b.historical,
  };
}
const pickCompletion = (t: Record<string, any>) => ({
  status: t.status, actual_start: t.actual_start ?? null, actual_end: t.actual_end ?? null, completion_date_unknown: t.completion_date_unknown,
  completion_note: t.completion_note, completion_historical: t.completion_historical,
});
function completionSummary(before: Record<string, any>, after: Record<string, any>, b: { date_unknown: boolean; note: string; override_reason: string }, issues: Array<{ message: string }>) {
  return `Recorded task ${after.name} as completed: ${before.status} → Completed; ${b.date_unknown ? 'exact completion date unknown' : `completed ${iso(after.actual_end)}`}`
    + `${b.note.trim() ? `; note: ${b.note.trim()}` : ''}${issues.length ? `; acknowledged: ${issues.map((x) => x.message).join(' / ')} — reason: ${b.override_reason.trim()}` : ''}`;
}

export function timelineRoutes(pool: pg.Pool, notifier: Notifier, timeZone = 'Asia/Qatar') {
  const r = Router({ mergeParams: true });
  const today = () => todayISO(timeZone);

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
      await assertProjectMember(c, pid, body.assigned_user_id);
      await checkDirectoryLinks(c, pid, body);
      const { depends_on, override_dependencies: _o, ...data } = body;
      const t = await insertRow(c, 'timeline_tasks', { ...data, project_id: pid });
      if (depends_on?.length) await setDependencies(c, pid, t.id as string, depends_on);
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'timeline_task', entityId: t.id as string, summary: `Added task ${body.name}`, after: { ...t, depends_on } });
      return t;
    });
    notifier.emit(taskAssignedEvents(null, row, req.user!.id));
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
      if (body.assigned_user_id !== undefined) await assertProjectMember(c, pid, body.assigned_user_id);
      await checkDirectoryLinks(c, pid, body as Record<string, unknown>, cur as never);
      const { depends_on, override_dependencies, ...data } = body;
      if (depends_on) await setDependencies(c, pid, id, depends_on);
      const nextStatus = data.status ?? cur.status;
      const nextEnd = data.actual_end !== undefined ? data.actual_end : cur.actual_end;
      const nextStart = data.actual_start !== undefined ? data.actual_start : cur.actual_start;
      assertActualDates(nextStart as string | null, nextEnd as string | null, today(), data.actual_start !== undefined || data.actual_end !== undefined);
      // a task completed with an unknown date stays valid while other fields are edited
      const keepsUnknown = !!cur.completion_date_unknown && nextStatus === 'Completed' && !nextEnd;
      if (cur.completion_date_unknown && !keepsUnknown) (data as Record<string, unknown>).completion_date_unknown = false;
      if (nextStatus === 'Completed') {
        if (!nextEnd && !keepsUnknown) throw badRequest('Enter the actual completion date to mark this task completed');
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
      return { before, after };
    });
    notifier.emit(taskAssignedEvents(out.before, out.after, req.user!.id));
    res.json(out.after);
  });

  // ---- completion workflow (also used to record work completed before the project was entered)
  const completionSchema = z.object({
    actual_end: zDate.optional(),
    actual_start: zDate.optional(),
    date_unknown: z.boolean().default(false),
    note: zText(2000).default(''),
    historical: z.boolean().default(false),
    override_reason: zText(1000).default(''),
  });
  const assertCompletionInput = (b: z.infer<typeof completionSchema>, allowHistorical: boolean) => {
    if ((b.date_unknown || b.historical) && !allowHistorical) throw forbidden('Historical progress entry is not enabled for this project');
    if (b.date_unknown && b.actual_end) throw badRequest('Leave the completion date empty when the exact date is unknown');
    if (!b.date_unknown && !b.actual_end) throw badRequest('Enter the actual completion date, or choose “Exact completion date unknown”');
  };

  r.post('/tasks/:id/complete', async (req, res) => {
    assertCap(req, 'timeline.write');
    const id = uuidParam(req, 'id');
    const body = parseBody(completionSchema, req);
    const pid = req.project!.id;
    assertCompletionInput(body, !!req.project!.allow_historical_progress);
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, any>>(c, 'timeline_tasks', pid, id, { forUpdate: true });
      if (cur.archived_at) throw badRequest('This task is archived. Restore it first.');
      if (cur.status === 'Completed') throw badRequest('This task is already completed');
      const start = body.actual_start ?? cur.actual_start ?? null;
      assertActualDates(start, body.actual_end ?? null, today(), true);
      const issues = await completionIssues(c, pid, cur, new Set([id]));
      if (issues.length && !body.override_reason.trim()) {
        throw new HttpError(409, 'Resolve or explain these before recording completion', { code: 'COMPLETION_ISSUES', issues: issues.map((x) => ({ ...x, task_id: id, task_name: cur.name })) });
      }
      const { before, after } = await patchOwned(c, 'timeline_tasks', pid, id, completionPatch(cur, body, req.user!.id, start));
      await audit(c, req, { projectId: pid, action: 'complete', entityType: 'timeline_task', entityId: id,
        summary: completionSummary(before, after, body, issues), before: pickCompletion(before), after: { ...pickCompletion(after), override_reason: body.override_reason || undefined } });
      return after;
    });
    res.json(out);
  });

  // several tasks of one phase in one reviewed, transactional action (historical progress projects only)
  r.post('/phases/:id/complete-tasks', async (req, res) => {
    assertCap(req, 'timeline.write');
    const phaseId = uuidParam(req, 'id');
    const body = parseBody(completionSchema.extend({ task_ids: z.array(z.string().uuid()).min(1, 'Select at least one task').max(300) }), req);
    const pid = req.project!.id;
    if (!req.project!.allow_historical_progress) throw forbidden('Historical progress entry is not enabled for this project');
    assertCompletionInput({ ...body, historical: true }, true);
    const batch = crypto.randomUUID();
    const out = await withTx(pool, async (c) => {
      const phase = await getOwned<Record<string, any>>(c, 'timeline_phases', pid, phaseId);
      const ids = [...new Set(body.task_ids)];
      const { rows } = await c.query('SELECT * FROM timeline_tasks WHERE id = ANY($1::uuid[]) AND project_id = $2 FOR UPDATE', [ids, pid]);
      if (rows.length !== ids.length || rows.some((t) => t.phase_id !== phaseId)) throw badRequest('Every selected task must belong to this phase');
      if (rows.some((t) => t.archived_at)) throw badRequest('Archived tasks cannot be completed');
      const todo = rows.filter((t) => t.status !== 'Completed'); // already completed tasks keep their dates and notes
      const selected = new Set(todo.map((t) => t.id as string));
      const issues: Array<{ code: string; message: string; task_id: string; task_name: string }> = [];
      for (const t of todo) {
        try { assertActualDates(t.actual_start, body.actual_end ?? null, today(), true); } catch (e) { throw badRequest(`${t.name}: ${(e as Error).message}`); }
        for (const x of await completionIssues(c, pid, t, selected)) issues.push({ ...x, task_id: t.id, task_name: t.name });
      }
      if (issues.length && !body.override_reason.trim()) throw new HttpError(409, 'Resolve or explain these before recording completion', { code: 'COMPLETION_ISSUES', issues });
      const done: string[] = [];
      for (const t of todo) {
        const { before, after } = await patchOwned(c, 'timeline_tasks', pid, t.id, completionPatch(t, { ...body, historical: true }, req.user!.id, t.actual_start ?? null));
        const mine = issues.filter((x) => x.task_id === t.id);
        await audit(c, req, { projectId: pid, action: 'complete', entityType: 'timeline_task', entityId: t.id,
          summary: `${completionSummary(before, after, body, mine)} — bulk completion of phase ${phase.seq}. ${phase.name} (batch ${batch.slice(0, 8)})`,
          before: pickCompletion(before), after: { ...pickCompletion(after), batch, override_reason: mine.length ? body.override_reason : undefined } });
        done.push(t.id);
      }
      if (done.length) {
        await audit(c, req, { projectId: pid, action: 'complete', entityType: 'timeline_phase', entityId: phaseId,
          summary: `Recorded ${done.length} task${done.length === 1 ? '' : 's'} of phase ${phase.seq}. ${phase.name} as completed (${body.actual_end ? `completed ${body.actual_end}` : 'exact date unknown'}; batch ${batch.slice(0, 8)})${rows.length - todo.length ? `; ${rows.length - todo.length} already completed and unchanged` : ''}`,
          after: { batch, task_ids: done, actual_end: body.actual_end ?? null, date_unknown: body.date_unknown, note: body.note, override_reason: issues.length ? body.override_reason : undefined } });
      }
      return { completed: done, skipped: rows.filter((t) => t.status === 'Completed').map((t) => t.id), batch };
    });
    res.json(out);
  });

  // correct an accidental completion: back to an open status, with a reason (the audit history keeps the old values)
  r.post('/tasks/:id/reopen', async (req, res) => {
    assertCap(req, 'timeline.write');
    const id = uuidParam(req, 'id');
    const body = parseBody(z.object({
      reason: zText(1000).min(3, 'Give a reason for reopening'),
      status: z.enum(['Not Scheduled', 'Scheduled', 'In Progress', 'On Hold', 'Blocked']).default('In Progress'),
    }), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, any>>(c, 'timeline_tasks', pid, id, { forUpdate: true });
      if (cur.status !== 'Completed') throw badRequest('Only a completed task can be reopened');
      const { before, after } = await patchOwned(c, 'timeline_tasks', pid, id, {
        status: body.status, actual_end: null, completion_date_unknown: false, completion_note: '', completion_recorded_at: null, completion_recorded_by: null, completion_historical: false,
      });
      await audit(c, req, { projectId: pid, action: 'reopen', entityType: 'timeline_task', entityId: id,
        summary: `Reopened task ${after.name}: Completed → ${after.status} — ${body.reason} (was ${before.actual_end ? `completed ${iso(before.actual_end)}` : before.completion_date_unknown ? 'completed, date unknown' : 'completed'})`,
        before: pickCompletion(before), after: { ...pickCompletion(after), reason: body.reason } });
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
