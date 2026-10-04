// Prerequisites & documents — project-specific checklist records.
//   /api/projects/:projectId/prerequisites                 GET list · POST create
//   /api/projects/:projectId/prerequisites/:id             PATCH (fields; status changes record a decision)
//   /api/projects/:projectId/prerequisites/:id/archive     POST   · /restore POST
//   /api/projects/:projectId/prerequisites/reorder         POST { ids } (active items, new order)
//
// Nothing is created automatically. Files use the existing secure attachments system
// (entity_type 'prerequisite'); an existing contract can be linked instead of uploading a copy.
// Uploading or viewing a file never changes the status: only an authorised user records
// Completed / Not applicable, and that decision (who, when, completion date) is stored and audited.
import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, parseBody, parsePatch, uuidParam, zDate, zText, zUrl } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertProjectMember, assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { can } from '../permissions';
import { PREREQUISITE_STATUSES } from '../../shared/constants';
import { todayISO } from '../../shared/calc';

const uuidOrNull = z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable());

const fields = z.object({
  title: zText(300).min(1, 'Title is required'),
  phase_id: uuidOrNull.optional(),
  responsible_user_id: uuidOrNull.optional(),
  responsible_name: zText(200).default(''),
  due_date: zDate.optional(),
  contract_id: uuidOrNull.optional(),
  document_url: zUrl.default(''),
  notes: zText(4000).default(''),
});
const statusChange = z.object({
  status: z.enum(PREREQUISITE_STATUSES),
  completed_on: zDate.optional(),
});

export async function loadPrerequisites(db: pg.Pool | pg.PoolClient, pid: string, includeArchived: boolean, showContracts: boolean) {
  const { rows } = await db.query(
    `SELECT q.*, ph.seq AS phase_seq, ph.name AS phase_name,
            COALESCE(NULLIF(ru.name, ''), q.responsible_name) AS responsible_display,
            du.name AS decided_by_name,
            k.title AS contract_title, k.company_name AS contract_company, k.status AS contract_status, k.archived_at AS contract_archived_at,
            (SELECT count(*)::int FROM attachments a WHERE a.project_id = k.project_id AND a.entity_type = 'contract' AND a.entity_id = k.id AND a.archived_at IS NULL) AS contract_file_count,
            (SELECT count(*)::int FROM attachments a WHERE a.project_id = q.project_id AND a.entity_type = 'prerequisite' AND a.entity_id = q.id AND a.archived_at IS NULL) AS attachment_count
       FROM project_prerequisites q
       LEFT JOIN timeline_phases ph ON ph.id = q.phase_id AND ph.project_id = q.project_id
       LEFT JOIN users ru ON ru.id = q.responsible_user_id
       LEFT JOIN users du ON du.id = q.decided_by
       LEFT JOIN contracts k ON k.id = q.contract_id AND k.project_id = q.project_id
      WHERE q.project_id = $1 AND ($2 OR q.archived_at IS NULL)
      ORDER BY q.archived_at NULLS FIRST, q.sort_order, q.created_at`,
    [pid, includeArchived],
  );
  if (showContracts) return rows;
  // the linked contract's details follow the contracts permission
  return rows.map(({ contract_title: _t, contract_company: _c, contract_status: _s, contract_archived_at: _a, contract_file_count: _f, ...r }) => ({ ...r, contract_linked: !!r.contract_id }));
}

async function assertLinks(c: pg.PoolClient, pid: string, body: Record<string, unknown>) {
  await assertSameProject(c, 'timeline_phases', pid, body.phase_id as string | null | undefined, 'Phase');
  await assertSameProject(c, 'contracts', pid, body.contract_id as string | null | undefined, 'Contract');
  await assertProjectMember(c, pid, body.responsible_user_id as string | null | undefined);
}

export function prerequisiteRoutes(pool: pg.Pool, timeZone: string) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'prerequisites.read');
    res.json(await loadPrerequisites(pool, req.project!.id, req.query.includeArchived === '1', can(req.user!.role, 'contracts.read')));
  });

  r.post('/', async (req, res) => {
    assertCap(req, 'prerequisites.write');
    const body = parseBody(fields, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertLinks(c, pid, body);
      const { rows } = await c.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM project_prerequisites WHERE project_id = $1', [pid]);
      const q = await insertRow(c, 'project_prerequisites', {
        ...body, phase_id: body.phase_id ?? null, responsible_user_id: body.responsible_user_id ?? null, due_date: body.due_date ?? null,
        contract_id: body.contract_id ?? null, project_id: pid, sort_order: rows[0].n, created_by: req.user!.id,
      });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'prerequisite', entityId: q.id as string, summary: `Added prerequisite "${q.title}"`, after: q });
      return q;
    });
    res.status(201).json(row);
  });

  r.post('/reorder', async (req, res) => {
    assertCap(req, 'prerequisites.write');
    const { ids } = parseBody(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }), req);
    const pid = req.project!.id;
    if (new Set(ids).size !== ids.length) throw badRequest('Duplicate ids');
    await withTx(pool, async (c) => {
      const { rows } = await c.query('SELECT id, title FROM project_prerequisites WHERE project_id = $1 AND archived_at IS NULL ORDER BY sort_order, created_at FOR UPDATE', [pid]);
      const known = new Set(rows.map((x) => x.id));
      if (ids.length !== rows.length || ids.some((x) => !known.has(x))) throw badRequest('Send every active prerequisite of this project exactly once, in the new order');
      for (let i = 0; i < ids.length; i++) await c.query('UPDATE project_prerequisites SET sort_order = $3, updated_at = now() WHERE id = $1 AND project_id = $2', [ids[i], pid, i + 1]);
      const byId = new Map(rows.map((x) => [x.id, x.title]));
      await audit(c, req, { projectId: pid, action: 'reorder', entityType: 'prerequisite', summary: 'Reordered prerequisites', before: rows.map((x) => x.title), after: ids.map((x) => byId.get(x)) });
    });
    res.json(await loadPrerequisites(pool, pid, false, can(req.user!.role, 'contracts.read')));
  });

  r.patch('/:id', async (req, res) => {
    assertCap(req, 'prerequisites.write');
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const body = parsePatch(fields.merge(statusChange).partial(), req) as Record<string, unknown>;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, unknown>>(c, 'project_prerequisites', pid, id, { forUpdate: true });
      if (cur.archived_at) throw badRequest('This prerequisite is archived. Restore it before editing.');
      await assertLinks(c, pid, body);
      const data: Record<string, unknown> = { ...body };
      delete data.completed_on;
      const nextStatus = (body.status as string | undefined) ?? (cur.status as string);
      if (body.status !== undefined && body.status !== cur.status) {
        // a status change is a recorded decision for Completed / Not applicable, and clears it otherwise
        if (nextStatus === 'Completed') {
          const on = (body.completed_on as string | null | undefined) ?? todayISO(timeZone);
          if (on > todayISO(timeZone)) throw badRequest('Completion date cannot be in the future');
          Object.assign(data, { completed_on: on, decided_by: req.user!.id, decided_at: new Date() });
        } else if (nextStatus === 'Not applicable') {
          Object.assign(data, { completed_on: null, decided_by: req.user!.id, decided_at: new Date() });
        } else {
          Object.assign(data, { completed_on: null, decided_by: null, decided_at: null });
        }
      } else if (body.completed_on !== undefined) {
        // correcting the recorded completion date of an item that is already completed
        if (cur.status !== 'Completed') throw badRequest('A completion date can only be recorded for a completed item');
        if (!body.completed_on) throw badRequest('A completed item needs a completion date');
        if ((body.completed_on as string) > todayISO(timeZone)) throw badRequest('Completion date cannot be in the future');
        data.completed_on = body.completed_on;
      }
      const { before, after } = await patchOwned(c, 'project_prerequisites', pid, id, data);
      const d = diff(before, after);
      const statusNote = before.status !== after.status ? ` — status ${before.status} → ${after.status}` : '';
      await audit(c, req, { projectId: pid, action: before.status !== after.status ? 'status' : 'update', entityType: 'prerequisite', entityId: id,
        summary: `Edited prerequisite "${after.title}"${statusNote} (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/:id/${action}`, async (req, res) => {
      assertCap(req, 'prerequisites.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        const extra: Record<string, unknown> = {};
        if (action === 'restore') {
          const { rows } = await c.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM project_prerequisites WHERE project_id = $1 AND archived_at IS NULL', [pid]);
          extra.sort_order = rows[0].n;
        }
        const { after } = await patchOwned(c, 'project_prerequisites', pid, id, { archived_at: action === 'archive' ? new Date() : null, ...extra });
        await audit(c, req, { projectId: pid, action, entityType: 'prerequisite', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} prerequisite "${after.title}"` });
        return after;
      });
      res.json(out);
    });
  }

  return r;
}
