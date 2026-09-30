import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { forbidden, parseBody, parsePatch, uuidParam, zDate, zDateTime, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertProjectMember, assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { can } from '../permissions';
import { CONSULTANT_VISIT_STATUSES, SITE_VISIT_STATUSES } from '../../shared/constants';
import type { Notifier } from '../notify/notifier';
import { consultantVisitEvents, siteVisitEvents } from '../notify/events';

const uuidOrNull = z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional();

const consultantSchema = z.object({
  planned_at: zDateTime.optional(),
  consultant_name: zText(200).default(''),
  consultant_user_id: uuidOrNull,
  purpose: zText(500).min(1),
  areas_inspected: zText(2000).default(''),
  status: z.enum(CONSULTANT_VISIT_STATUSES).default('Planned'),
  observations: zText(8000).default(''),
  instructions: zText(8000).default(''),
  next_visit_date: zDate.optional(),
  related_task_id: uuidOrNull,
  related_material_id: uuidOrNull,
  notes: zText(4000).default(''),
});

const siteSchema = z.object({
  visit_at: zDateTime.optional(),
  assigned_user_id: uuidOrNull,
  assigned_name: zText(200).default(''),
  purpose: zText(500).min(1),
  areas: zText(2000).default(''),
  status: z.enum(SITE_VISIT_STATUSES).default('Planned'),
  findings: zText(8000).default(''),
  related_task_id: uuidOrNull,
  related_material_id: uuidOrNull,
  related_consultant_visit_id: uuidOrNull,
  notes: zText(4000).default(''),
});

const actionSchema = z.object({
  description: zText(1000).min(1),
  responsible: zText(200).default(''),
  due_date: zDate.optional(),
  status: z.enum(['Open', 'Closed']).default('Open'),
});

// Fields an assignee (contractor/consultant on a site visit) may update
const SITE_ASSIGNEE_FIELDS = ['status', 'findings', 'notes'];

async function checkLinks(c: pg.PoolClient, pid: string, b: Record<string, unknown>) {
  await assertSameProject(c, 'timeline_tasks', pid, b.related_task_id as string, 'Related task');
  await assertSameProject(c, 'material_items', pid, b.related_material_id as string, 'Related material');
  await assertSameProject(c, 'consultant_visits', pid, b.related_consultant_visit_id as string, 'Related consultant visit');
}

/** Can the user write this consultant visit? */
export function canWriteConsultantVisit(req: Request, visit: { consultant_user_id: string | null } | null) {
  const u = req.user!;
  if (can(u.role, 'consultant.write')) return true;
  if (can(u.role, 'consultant.own')) return !visit || visit.consultant_user_id === u.id;
  return false;
}
export function canWriteSiteVisit(req: Request, visit: { assigned_user_id: string | null }, full = false) {
  const u = req.user!;
  if (can(u.role, 'site.write')) return true;
  if (full) return false;
  return can(u.role, 'site.assigned') && visit.assigned_user_id === u.id;
}

export function visitRoutes(pool: pg.Pool, notifier: Notifier) {
  const r = Router({ mergeParams: true });

  // ======================= consultant visits
  r.get('/consultant', async (req, res) => {
    assertCap(req, 'consultant.read');
    const pid = req.project!.id;
    const inc = req.query.includeArchived === '1';
    const [v, a] = await Promise.all([
      pool.query(
        `SELECT v.*, u.name AS consultant_user_name,
                (SELECT count(*)::int FROM attachments x WHERE x.entity_type='consultant_visit' AND x.entity_id=v.id AND x.archived_at IS NULL) AS attachment_count
           FROM consultant_visits v LEFT JOIN users u ON u.id = v.consultant_user_id
          WHERE v.project_id = $1 AND ($2 OR v.archived_at IS NULL) ORDER BY v.planned_at NULLS LAST, v.created_at`,
        [pid, inc],
      ),
      pool.query(`SELECT * FROM visit_actions WHERE project_id = $1 AND visit_type = 'consultant' AND archived_at IS NULL ORDER BY due_date NULLS LAST, created_at`, [pid]),
    ]);
    res.json(v.rows.map((x) => ({ ...x, actions: a.rows.filter((y) => y.visit_id === x.id) })));
  });

  r.post('/consultant', async (req, res) => {
    if (!canWriteConsultantVisit(req, null)) throw forbidden();
    const body = parseBody(consultantSchema, req);
    const pid = req.project!.id;
    const u = req.user!;
    const row = await withTx(pool, async (c) => {
      await checkLinks(c, pid, body);
      if (!can(u.role, 'consultant.write')) {
        body.consultant_user_id = u.id; // consultants can only create their own visits
        if (!body.consultant_name) body.consultant_name = u.name;
      } else {
        await assertProjectMember(c, pid, body.consultant_user_id, ['consultant']);
      }
      const v = await insertRow(c, 'consultant_visits', { ...body, project_id: pid, created_by: u.id });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'consultant_visit', entityId: v.id as string, summary: `Added consultant visit: ${body.purpose}`, after: v });
      return v;
    });
    notifier.emit(consultantVisitEvents(null, row, u.id));
    res.status(201).json(row);
  });

  r.patch('/consultant/:id', async (req, res) => {
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const body = parsePatch(consultantSchema.partial(), req);
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<{ consultant_user_id: string | null }>(c, 'consultant_visits', pid, id);
      if (!canWriteConsultantVisit(req, cur)) throw forbidden();
      if (!can(req.user!.role, 'consultant.write')) delete body.consultant_user_id; // cannot reassign
      else if (body.consultant_user_id !== undefined) await assertProjectMember(c, pid, body.consultant_user_id, ['consultant']);
      await checkLinks(c, pid, body);
      const { before, after } = await patchOwned(c, 'consultant_visits', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'consultant_visit', entityId: id, summary: `Edited consultant visit (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return { before, after };
    });
    notifier.emit(consultantVisitEvents(out.before, out.after, req.user!.id));
    res.json(out.after);
  });

  // ======================= site visits
  r.get('/site', async (req, res) => {
    assertCap(req, 'site.read');
    const pid = req.project!.id;
    const inc = req.query.includeArchived === '1';
    const [v, a] = await Promise.all([
      pool.query(
        `SELECT v.*, u.name AS assigned_user_name,
                (SELECT count(*)::int FROM attachments x WHERE x.entity_type='site_visit' AND x.entity_id=v.id AND x.archived_at IS NULL) AS attachment_count
           FROM site_visits v LEFT JOIN users u ON u.id = v.assigned_user_id
          WHERE v.project_id = $1 AND ($2 OR v.archived_at IS NULL) ORDER BY v.visit_at NULLS LAST, v.created_at`,
        [pid, inc],
      ),
      pool.query(`SELECT * FROM visit_actions WHERE project_id = $1 AND visit_type = 'site' AND archived_at IS NULL ORDER BY due_date NULLS LAST, created_at`, [pid]),
    ]);
    res.json(v.rows.map((x) => ({ ...x, actions: a.rows.filter((y) => y.visit_id === x.id) })));
  });

  r.post('/site', async (req, res) => {
    assertCap(req, 'site.write');
    const body = parseBody(siteSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await checkLinks(c, pid, body);
      await assertProjectMember(c, pid, body.assigned_user_id);
      const v = await insertRow(c, 'site_visits', { ...body, project_id: pid, created_by: req.user!.id });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'site_visit', entityId: v.id as string, summary: `Added site visit: ${body.purpose}`, after: v });
      return v;
    });
    notifier.emit(siteVisitEvents(null, row, req.user!.id));
    res.status(201).json(row);
  });

  r.patch('/site/:id', async (req, res) => {
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const body = parsePatch(siteSchema.partial(), req) as Record<string, unknown>;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<{ assigned_user_id: string | null }>(c, 'site_visits', pid, id);
      if (!canWriteSiteVisit(req, cur)) throw forbidden();
      const patch = body;
      if (!can(req.user!.role, 'site.write')) {
        const bad = Object.keys(body).filter((k) => body[k] !== undefined && !SITE_ASSIGNEE_FIELDS.includes(k));
        if (bad.length) throw forbidden(`You can only update: ${SITE_ASSIGNEE_FIELDS.join(', ')}`);
      } else {
        await checkLinks(c, pid, body);
        if (body.assigned_user_id !== undefined) await assertProjectMember(c, pid, body.assigned_user_id as string | null);
      }
      const { before, after } = await patchOwned(c, 'site_visits', pid, id, patch);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'site_visit', entityId: id, summary: `Edited site visit (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return { before, after };
    });
    notifier.emit(siteVisitEvents(out.before, out.after, req.user!.id));
    res.json(out.after);
  });

  // ======================= archive / restore
  for (const kind of ['consultant', 'site'] as const) {
    for (const action of ['archive', 'restore'] as const) {
      r.post(`/${kind}/:id/${action}`, async (req, res) => {
        const id = uuidParam(req, 'id');
        const pid = req.project!.id;
        const table = kind === 'consultant' ? 'consultant_visits' : 'site_visits';
        const out = await withTx(pool, async (c) => {
          const cur = await getOwned<Record<string, unknown>>(c, table, pid, id);
          const allowed = kind === 'consultant'
            ? canWriteConsultantVisit(req, cur as { consultant_user_id: string | null })
            : canWriteSiteVisit(req, cur as { assigned_user_id: string | null }, true);
          if (!allowed) throw forbidden();
          const { after } = await patchOwned(c, table, pid, id, { archived_at: action === 'archive' ? new Date() : null });
          await audit(c, req, { projectId: pid, action, entityType: `${kind}_visit`, entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} ${kind} visit: ${after.purpose}` });
          return after;
        });
        res.json(out);
      });
    }
  }

  // ======================= follow-up actions
  async function assertVisitWritable(c: pg.PoolClient, req: Request, type: 'consultant' | 'site', visitId: string) {
    const pid = req.project!.id;
    if (type === 'consultant') {
      const v = await getOwned<{ consultant_user_id: string | null }>(c, 'consultant_visits', pid, visitId);
      if (!canWriteConsultantVisit(req, v)) throw forbidden();
    } else {
      const v = await getOwned<{ assigned_user_id: string | null }>(c, 'site_visits', pid, visitId);
      if (!canWriteSiteVisit(req, v)) throw forbidden();
    }
  }

  r.post('/:type/:id/actions', async (req, res) => {
    const type = req.params.type;
    if (type !== 'consultant' && type !== 'site') throw forbidden();
    const visitId = uuidParam(req, 'id');
    const body = parseBody(actionSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertVisitWritable(c, req, type, visitId);
      const a = await insertRow(c, 'visit_actions', { ...body, project_id: pid, visit_type: type, visit_id: visitId });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'visit_action', entityId: a.id as string, summary: `Added follow-up action: ${body.description}`, after: a });
      return a;
    });
    res.status(201).json(row);
  });

  r.patch('/actions/:id', async (req, res) => {
    const id = uuidParam(req, 'id');
    const body = parsePatch(actionSchema.partial().extend({ archived: z.boolean().optional() }), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<{ visit_type: 'consultant' | 'site'; visit_id: string }>(c, 'visit_actions', pid, id);
      await assertVisitWritable(c, req, cur.visit_type, cur.visit_id);
      const { archived, ...rest } = body;
      const patch: Record<string, unknown> = { ...rest };
      if (archived !== undefined) patch.archived_at = archived ? new Date() : null;
      const { before, after } = await patchOwned(c, 'visit_actions', pid, id, patch);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: archived ? 'archive' : 'update', entityType: 'visit_action', entityId: id, summary: `Edited follow-up action (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  return r;
}

