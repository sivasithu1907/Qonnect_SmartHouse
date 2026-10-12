import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, forbidden, parseBody, parsePatch, uuidParam, zDate, zDateTime, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertProjectMember, assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { can } from '../permissions';
import { CONSULTANT_VISIT_STATUSES, SITE_VISIT_STATUSES, siteVisitState, visitState } from '../../shared/constants';
import type { Notifier } from '../notify/notifier';
import { consultantVisitEvents, siteVisitEvents } from '../notify/events';
import { checkDirectoryLinks, directoryJoin, directoryLinkFields, directorySelect } from '../lib/directoryLinks';

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
  actual_visit_at: zDateTime.optional(),
  assigned_user_id: uuidOrNull,
  related_milestone_id: uuidOrNull,
  cancel_reason: zText(1000).optional(),
  ...directoryLinkFields,
});

const siteSchema = z.object({
  visit_at: zDateTime.optional(),
  assigned_user_id: uuidOrNull,
  assigned_name: zText(200).default(''),
  purpose: zText(500).min(1),
  areas: zText(2000).default(''),
  status: z.enum(SITE_VISIT_STATUSES).default('Planned'),
  findings: zText(8000).default(''),
  decisions: zText(8000).default(''),
  related_task_id: uuidOrNull,
  related_material_id: uuidOrNull,
  related_consultant_visit_id: uuidOrNull,
  notes: zText(4000).default(''),
  actual_visit_at: zDateTime.optional(),
  ...directoryLinkFields,
});

const actionSchema = z.object({
  description: zText(1000).min(1),
  responsible: zText(200).default(''),
  responsible_user_id: uuidOrNull,
  due_date: zDate.optional(),
  status: z.enum(['Open', 'Closed']).default('Open'),
});

// Fields an assignee (contractor/consultant on a site visit) may update
const SITE_ASSIGNEE_FIELDS = ['status', 'findings', 'decisions', 'notes'];

async function checkLinks(c: pg.PoolClient, pid: string, b: Record<string, unknown>) {
  await assertSameProject(c, 'payment_milestones', pid, b.related_milestone_id as string, 'Related payment');
  await assertProjectMember(c, pid, b.assigned_user_id as string | null | undefined);
  await assertSameProject(c, 'timeline_tasks', pid, b.related_task_id as string, 'Related task');
  await assertSameProject(c, 'material_items', pid, b.related_material_id as string, 'Related material');
  await assertSameProject(c, 'consultant_visits', pid, b.related_consultant_visit_id as string, 'Related consultant visit');
}

function assertNotFuture(iso: string) {
  if (Date.parse(iso) > Date.now() + 5 * 60_000) throw badRequest('The actual visit date and time cannot be in the future');
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
        `SELECT v.*, u.name AS consultant_user_name, au.name AS assigned_user_name, ${directorySelect('v')},
                dc_v.position AS directory_contact_position, dc_v.mobile AS directory_contact_mobile, dc_v.whatsapp AS directory_contact_whatsapp, dc_v.email AS directory_contact_email,
                de_v.phone AS directory_entry_phone, de_v.email AS directory_entry_email,
                t.name AS related_task_name, pm.payee_name AS related_milestone_payee, pm.description AS related_milestone_description,
                (SELECT count(*)::int FROM attachments x WHERE x.entity_type='consultant_visit' AND x.entity_id=v.id AND x.archived_at IS NULL) AS attachment_count,
                (SELECT count(*)::int FROM attachments x WHERE x.entity_type='consultant_visit' AND x.entity_id=v.id AND x.kind='consultant_report' AND x.archived_at IS NULL) AS report_count,
                (SELECT count(*)::int FROM visit_comments cm WHERE cm.visit_type='consultant' AND cm.visit_id=v.id AND cm.archived_at IS NULL) AS comment_count
           FROM consultant_visits v LEFT JOIN users u ON u.id = v.consultant_user_id LEFT JOIN users au ON au.id = v.assigned_user_id
           LEFT JOIN timeline_tasks t ON t.id = v.related_task_id AND t.project_id = v.project_id
           LEFT JOIN payment_milestones pm ON pm.id = v.related_milestone_id AND pm.project_id = v.project_id
           ${directoryJoin('v')}
          WHERE v.project_id = $1 AND ($2 OR v.archived_at IS NULL) ORDER BY v.planned_at NULLS LAST, v.created_at`,
        [pid, inc],
      ),
      pool.query(`SELECT * FROM visit_actions WHERE project_id = $1 AND visit_type = 'consultant' AND archived_at IS NULL ORDER BY due_date NULLS LAST, created_at`, [pid]),
    ]);
    const role = req.user!.role;
    res.json(v.rows.map((x) => {
      const row: Record<string, unknown> = { ...x, visit_state: visitState(x.status), report_status: x.report_count > 0 ? 'Report uploaded' : 'Report pending', actions: a.rows.filter((y) => y.visit_id === x.id) };
      // contact details follow the directory permission; payment details follow the payments permission
      if (!can(role, 'directory.read')) for (const k of ['directory_contact_position', 'directory_contact_mobile', 'directory_contact_whatsapp', 'directory_contact_email', 'directory_entry_phone', 'directory_entry_email']) delete row[k];
      if (!can(role, 'payments.read')) { delete row.related_milestone_payee; delete row.related_milestone_description; }
      return row;
    }));
  });

  r.post('/consultant', async (req, res) => {
    if (!canWriteConsultantVisit(req, null)) throw forbidden();
    const body = parseBody(consultantSchema, req);
    const pid = req.project!.id;
    const u = req.user!;
    const row = await withTx(pool, async (c) => {
      await checkLinks(c, pid, body);
      if (body.related_milestone_id && !can(u.role, 'payments.read')) throw forbidden('Linking a payment requires payment access');
      if (!can(u.role, 'consultant.write')) {
        if (body.directory_entry_id || body.directory_contact_id) throw forbidden('Only a project manager can link directory contacts');
        if (body.assigned_user_id || body.related_milestone_id) throw forbidden('Only a project manager can assign the visit or link a payment');
        body.consultant_user_id = u.id; // consultants can only create their own visits
        if (!body.consultant_name) body.consultant_name = u.name;
      } else {
        await assertProjectMember(c, pid, body.consultant_user_id, ['consultant']);
        await checkDirectoryLinks(c, pid, body);
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
      const cur = await getOwned<{ consultant_user_id: string | null; directory_entry_id: string | null; directory_contact_id: string | null }>(c, 'consultant_visits', pid, id);
      if (!canWriteConsultantVisit(req, cur)) throw forbidden();
      if (body.related_milestone_id !== undefined && !can(req.user!.role, 'payments.read')) throw forbidden('Linking a payment requires payment access');
      if (!can(req.user!.role, 'consultant.write')) {
        delete body.consultant_user_id; // cannot reassign
        if (body.assigned_user_id !== undefined || body.related_milestone_id !== undefined) throw forbidden('Only a project manager can assign the visit or link a payment');
        if (body.directory_entry_id !== undefined || body.directory_contact_id !== undefined) throw forbidden('Only a project manager can change directory links');
      } else {
        if (body.consultant_user_id !== undefined) await assertProjectMember(c, pid, body.consultant_user_id, ['consultant']);
        await checkDirectoryLinks(c, pid, body as Record<string, unknown>, cur as never);
      }
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
        `SELECT v.*, u.name AS assigned_user_name, ${directorySelect('v')},
                dc_v.position AS directory_contact_position, dc_v.mobile AS directory_contact_mobile, dc_v.whatsapp AS directory_contact_whatsapp, dc_v.email AS directory_contact_email,
                de_v.phone AS directory_entry_phone, de_v.email AS directory_entry_email,
                t.name AS related_task_name, mi.description AS related_material_description, cv.purpose AS related_consultant_visit_purpose, cv.planned_at AS related_consultant_visit_at,
                (SELECT count(*)::int FROM attachments x WHERE x.entity_type='site_visit' AND x.entity_id=v.id AND x.archived_at IS NULL) AS attachment_count,
                (SELECT count(*)::int FROM visit_comments cm WHERE cm.visit_type='site' AND cm.visit_id=v.id AND cm.archived_at IS NULL) AS comment_count
           FROM site_visits v LEFT JOIN users u ON u.id = v.assigned_user_id ${directoryJoin('v')}
           LEFT JOIN timeline_tasks t ON t.id = v.related_task_id AND t.project_id = v.project_id
           LEFT JOIN material_items mi ON mi.id = v.related_material_id AND mi.project_id = v.project_id
           LEFT JOIN consultant_visits cv ON cv.id = v.related_consultant_visit_id AND cv.project_id = v.project_id
          WHERE v.project_id = $1 AND ($2 OR v.archived_at IS NULL) ORDER BY v.visit_at NULLS LAST, v.created_at`,
        [pid, inc],
      ),
      pool.query(`SELECT * FROM visit_actions WHERE project_id = $1 AND visit_type = 'site' AND archived_at IS NULL ORDER BY due_date NULLS LAST, created_at`, [pid]),
    ]);
    const role = req.user!.role;
    res.json(v.rows.map((x) => {
      const actions = a.rows.filter((y) => y.visit_id === x.id);
      const row: Record<string, unknown> = { ...x, visit_state: siteVisitState(x.status), open_action_count: actions.filter((y) => y.status === 'Open').length, actions };
      if (!can(role, 'directory.read')) for (const k of ['directory_contact_position', 'directory_contact_mobile', 'directory_contact_whatsapp', 'directory_contact_email', 'directory_entry_phone', 'directory_entry_email']) delete row[k];
      if (!can(role, 'materials.read')) delete row.related_material_description;
      if (!can(role, 'timeline.read')) delete row.related_task_name;
      if (!can(role, 'consultant.read')) { delete row.related_consultant_visit_purpose; delete row.related_consultant_visit_at; }
      return row;
    }));
  });

  r.post('/site', async (req, res) => {
    assertCap(req, 'site.write');
    const body = parseBody(siteSchema, req);
    const pid = req.project!.id;
    if (body.status === 'Cancelled') throw badRequest('Use "Cancel visit" on a saved visit; it records the reason.');
    if (body.actual_visit_at) assertNotFuture(body.actual_visit_at);
    const row = await withTx(pool, async (c) => {
      await checkLinks(c, pid, body);
      await assertProjectMember(c, pid, body.assigned_user_id);
      await checkDirectoryLinks(c, pid, body);
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
      const cur = await getOwned<{ assigned_user_id: string | null; directory_entry_id: string | null; directory_contact_id: string | null }>(c, 'site_visits', pid, id);
      if (!canWriteSiteVisit(req, cur)) throw forbidden();
      const patch = body;
      if (body.status === 'Cancelled' && (cur as Record<string, unknown>).status !== 'Cancelled') throw badRequest('Use "Cancel visit"; it records the reason.');
      if (body.actual_visit_at) assertNotFuture(body.actual_visit_at as string);
      if (!can(req.user!.role, 'site.write')) {
        const bad = Object.keys(body).filter((k) => body[k] !== undefined && !SITE_ASSIGNEE_FIELDS.includes(k));
        if (bad.length) throw forbidden(`You can only update: ${SITE_ASSIGNEE_FIELDS.join(', ')}`);
      } else {
        await checkLinks(c, pid, body);
        if (body.assigned_user_id !== undefined) await assertProjectMember(c, pid, body.assigned_user_id as string | null);
        await checkDirectoryLinks(c, pid, body, cur as never);
      }
      const { before, after } = await patchOwned(c, 'site_visits', pid, id, patch);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'site_visit', entityId: id, summary: `Edited site visit (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return { before, after };
    });
    notifier.emit(siteVisitEvents(out.before, out.after, req.user!.id));
    res.json(out.after);
  });

  // ======================= consultant visit workflow (status changes are explicit and audited)
  const workflow = async (req: Request, id: string, change: (cur: Record<string, any>) => Record<string, unknown>, summary: (cur: Record<string, any>, next: Record<string, any>) => string) => {
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, any>>(c, 'consultant_visits', pid, id, { forUpdate: true });
      if (!canWriteConsultantVisit(req, cur as { consultant_user_id: string | null })) throw forbidden();
      if (cur.archived_at) throw badRequest('This visit is archived. Restore it first.');
      const { before, after } = await patchOwned(c, 'consultant_visits', pid, id, change(cur));
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'status', entityType: 'consultant_visit', entityId: id, summary: summary(before, after), before: d.before, after: d.after });
      return { before, after };
    });
    notifier.emit(consultantVisitEvents(out.before, out.after, req.user!.id));
    return out.after;
  };
  const nowIso = () => new Date().toISOString();
  const fmt = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 16).replace('T', ' ') : 'no date');

  r.post('/consultant/:id/reschedule', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { planned_at, reason } = parseBody(z.object({ planned_at: zDateTime.refine((v) => !!v, 'A new date and time is required'), reason: zText(1000).default('') }), req);
    res.json(await workflow(req, id, (cur) => {
      if (cur.status === 'Completed') throw badRequest('A completed visit cannot be rescheduled. Schedule a new visit instead.');
      return { planned_at, status: 'Rescheduled', cancel_reason: '' };
    }, (b, a) => `Rescheduled consultant visit "${a.purpose}": ${fmt(b.planned_at)} → ${fmt(a.planned_at)}${reason ? ` — ${reason}` : ''}`));
  });

  r.post('/consultant/:id/complete', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { actual_visit_at } = parseBody(z.object({ actual_visit_at: zDateTime.optional() }), req);
    if (actual_visit_at && Date.parse(actual_visit_at) > Date.now() + 5 * 60_000) throw badRequest('The actual visit date cannot be in the future');
    res.json(await workflow(req, id, (cur) => {
      if (cur.status === 'Cancelled') throw badRequest('A cancelled visit cannot be completed. Reschedule it first.');
      const planned = cur.planned_at && Date.parse(cur.planned_at) <= Date.now() ? new Date(cur.planned_at).toISOString() : nowIso();
      return { status: 'Completed', actual_visit_at: actual_visit_at ?? cur.actual_visit_at ?? planned };
    }, (_b, a) => `Marked consultant visit "${a.purpose}" completed (visited ${fmt(a.actual_visit_at)}); report status is unchanged`));
  });

  r.post('/consultant/:id/cancel', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { reason } = parseBody(z.object({ reason: zText(1000).default('') }), req);
    res.json(await workflow(req, id, (cur) => {
      if (cur.status === 'Completed') throw badRequest('A completed visit cannot be cancelled.');
      return { status: 'Cancelled', cancel_reason: reason };
    }, (_b, a) => `Cancelled consultant visit "${a.purpose}"${reason ? ` — ${reason}` : ''}`));
  });

  r.get('/consultant/:id/history', async (req, res) => {
    assertCap(req, 'consultant.read');
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    await getOwned(pool, 'consultant_visits', pid, id);
    const { rows } = await pool.query(
      `SELECT l.id, l.action, l.summary, l.created_at, COALESCE(u.name, l.user_email) AS who
         FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.project_id = $1 AND l.entity_type = 'consultant_visit' AND l.entity_id = $2
        ORDER BY l.created_at DESC, l.id DESC LIMIT 200`, [pid, id]);
    res.json(rows);
  });

  // ======================= site visit workflow
  // Start / complete: managers and the assigned user. Reschedule / cancel: managers only (site.write).
  const siteFlow = async (req: Request, id: string, full: boolean, change: (cur: Record<string, any>) => Record<string, unknown>, summary: (b: Record<string, any>, a: Record<string, any>) => string) => {
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, any>>(c, 'site_visits', pid, id, { forUpdate: true });
      if (!canWriteSiteVisit(req, cur as { assigned_user_id: string | null }, full)) throw forbidden(full ? 'Only a project manager can do this' : undefined);
      if (cur.archived_at) throw badRequest('This visit is archived. Restore it first.');
      const { before, after } = await patchOwned(c, 'site_visits', pid, id, change(cur));
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'status', entityType: 'site_visit', entityId: id, summary: summary(before, after), before: d.before, after: d.after });
      return { before, after };
    });
    notifier.emit(siteVisitEvents(out.before, out.after, req.user!.id));
    return out.after;
  };

  r.post('/site/:id/start', async (req, res) => {
    const id = uuidParam(req, 'id');
    res.json(await siteFlow(req, id, false, (cur) => {
      if (cur.status === 'Completed' || cur.status === 'Cancelled') throw badRequest(`A ${cur.status.toLowerCase()} visit cannot be started.`);
      if (cur.status === 'In Progress') throw badRequest('This visit is already in progress.');
      return { status: 'In Progress', started_at: nowIso() };
    }, (_b, a) => `Started site visit "${a.purpose}"`));
  });

  r.post('/site/:id/complete', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { actual_visit_at } = parseBody(z.object({ actual_visit_at: zDateTime.refine((v) => !!v, 'The actual visit date and time is required') }), req);
    assertNotFuture(actual_visit_at as string);
    res.json(await siteFlow(req, id, false, (cur) => {
      if (cur.status === 'Cancelled') throw badRequest('A cancelled visit cannot be completed. Reschedule it first.');
      if (cur.status === 'Completed') throw badRequest('This visit is already completed.');
      return { status: 'Completed', actual_visit_at };
    }, (_b, a) => `Marked site visit "${a.purpose}" completed (visited ${fmt(a.actual_visit_at)}); follow-up actions are unchanged`));
  });

  r.post('/site/:id/reschedule', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { visit_at, reason } = parseBody(z.object({ visit_at: zDateTime.refine((v) => !!v, 'A new date and time is required'), reason: zText(1000).default('') }), req);
    res.json(await siteFlow(req, id, true, (cur) => {
      if (cur.status === 'Completed') throw badRequest('A completed visit cannot be rescheduled. Schedule a new visit instead.');
      return { visit_at, status: 'Rescheduled', cancel_reason: '', started_at: null };
    }, (b, a) => `Rescheduled site visit "${a.purpose}": ${fmt(b.visit_at)} → ${fmt(a.visit_at)}${b.status === 'Cancelled' ? ' (reopened after cancellation)' : ''}${reason ? ` — ${reason}` : ''}`));
  });

  r.post('/site/:id/cancel', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { reason } = parseBody(z.object({ reason: zText(1000).min(1, 'A cancellation reason is required') }), req);
    res.json(await siteFlow(req, id, true, (cur) => {
      if (cur.status === 'Completed') throw badRequest('A completed visit cannot be cancelled.');
      if (cur.status === 'Cancelled') throw badRequest('This visit is already cancelled.');
      return { status: 'Cancelled', cancel_reason: reason };
    }, (_b, a) => `Cancelled site visit "${a.purpose}" — ${reason}`));
  });

  r.get('/site/:id/history', async (req, res) => {
    assertCap(req, 'site.read');
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    await getOwned(pool, 'site_visits', pid, id);
    const { rows } = await pool.query(
      `SELECT l.id, l.action, l.summary, l.created_at, COALESCE(u.name, l.user_email) AS who
         FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.project_id = $1 AND l.entity_type = 'site_visit' AND l.entity_id = $2
        ORDER BY l.created_at DESC, l.id DESC LIMIT 200`, [pid, id]);
    res.json(rows);
  });

  // ======================= comments (consultant and site visits)
  const visitTable = (t: string) => (t === 'consultant' ? 'consultant_visits' : t === 'site' ? 'site_visits' : null);
  r.get('/:type/:id/comments', async (req, res) => {
    const type = req.params.type;
    const table = visitTable(type);
    if (!table) throw forbidden();
    assertCap(req, type === 'consultant' ? 'consultant.read' : 'site.read');
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    await getOwned(pool, table, pid, id);
    const { rows } = await pool.query(
      `SELECT cm.id, cm.body, cm.created_at, cm.author_id, u.name AS author_name
         FROM visit_comments cm LEFT JOIN users u ON u.id = cm.author_id
        WHERE cm.project_id = $1 AND cm.visit_type = $2 AND cm.visit_id = $3 AND cm.archived_at IS NULL
        ORDER BY cm.created_at`, [pid, type, id]);
    res.json(rows);
  });

  r.post('/:type/:id/comments', async (req, res) => {
    const type = req.params.type;
    if (type !== 'consultant' && type !== 'site') throw forbidden();
    const visitId = uuidParam(req, 'id');
    const { body } = parseBody(z.object({ body: zText(4000).min(1, 'Write a comment') }), req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertVisitWritable(c, req, type, visitId);
      const cm = await insertRow(c, 'visit_comments', { project_id: pid, visit_type: type, visit_id: visitId, author_id: req.user!.id, body });
      await audit(c, req, { projectId: pid, action: 'comment', entityType: `${type}_visit`, entityId: visitId, summary: `Comment: ${body.slice(0, 200)}` });
      return { ...cm, author_name: req.user!.name };
    });
    res.status(201).json(row);
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
      await assertProjectMember(c, pid, body.responsible_user_id);
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
      if (body.responsible_user_id !== undefined) await assertProjectMember(c, pid, body.responsible_user_id);
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

