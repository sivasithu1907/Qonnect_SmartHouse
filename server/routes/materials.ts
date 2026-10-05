import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { forbidden, parseBody, parsePatch, uuidParam, zDate, zMoney, zQty, zText, zUrl } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertProjectMember, getOwned, insertRow, patchOwned } from '../lib/crud';
import { badRequest } from '../lib/http';
import { can, CONTRACTOR_MATERIAL_FIELDS } from '../permissions';
import { INSPECTION_STATUSES, MATERIAL_STATUSES, SUPPLY_RESPONSIBILITIES } from '../../shared/constants';
import type { Notifier } from '../notify/notifier';
import { materialDateEvents } from '../notify/events';
import { todayISO } from '../../shared/calc';
import { DATE_FIELD_LABELS, materialSchedule, type DateField } from '../../shared/materialSchedule';

export async function loadMaterials(db: pg.Pool | pg.PoolClient, projectId: string, includeArchived = false) {
  const [items, notes] = await Promise.all([
    db.query(
      `SELECT mi.*, mc.name AS category, mc.sort_order AS category_sort, mc.archived_at AS category_archived_at,
              u.name AS assigned_contractor_name,
              (SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'material' AND a.entity_id = mi.id AND a.archived_at IS NULL) AS attachment_count
         FROM material_items mi
         LEFT JOIN material_categories mc ON mc.id = mi.category_id
         LEFT JOIN users u ON u.id = mi.assigned_contractor_id
        WHERE mi.project_id = $1 AND ($2 OR mi.archived_at IS NULL)
        ORDER BY mc.sort_order NULLS LAST, mi.sort_order, mi.created_at`,
      [projectId, includeArchived],
    ),
    db.query(
      `SELECT n.*, mc.name AS category FROM material_scope_notes n
         LEFT JOIN material_categories mc ON mc.id = n.category_id
        WHERE n.project_id = $1 ORDER BY mc.sort_order NULLS LAST, n.category`,
      [projectId],
    ),
  ]);
  return { items: items.rows, scopeNotes: notes.rows };
}

const DATE_FIELDS = ['required_on_site_date', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date',
  'planned_completion_date', 'actual_completion_date'];

/** An actual delivery / completion date can't be later than today (application time zone). */
function assertActualDatesNotFuture(body: Record<string, unknown>, today: string) {
  for (const f of ['actual_delivery_date', 'actual_completion_date'] as const) {
    const v = body[f];
    if (typeof v === 'string' && v.slice(0, 10) > today) {
      throw badRequest(`${f === 'actual_delivery_date' ? 'Actual delivery' : 'Actual completion'} date can't be in the future. Enter it once the ${f === 'actual_delivery_date' ? 'material has arrived' : 'work has finished'}.`);
    }
  }
}

/** Material lines must use a category from the project's centrally managed list. */
async function assertMaterialCategory(c: pg.PoolClient, projectId: string, categoryId: string) {
  const { rows } = await c.query('SELECT archived_at FROM material_categories WHERE id = $1 AND project_id = $2', [categoryId, projectId]);
  if (!rows[0]) throw badRequest('Material category not found in this project');
  if (rows[0].archived_at) throw badRequest('This material category is archived. Restore it in Manage Categories or choose another category.');
}

const materialSchema = z.object({
  category_id: z.string().uuid(),
  description: zText(400).min(1),
  quantity: zQty.optional(),
  unit: zText(40).default(''),
  amount: zMoney.optional(),
  supply_responsibility: z.enum(SUPPLY_RESPONSIBILITIES).default('needs_confirmation'),
  responsibility_note: zText(1000).default(''),
  vendor: zText(200).default(''),
  assigned_contractor_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional(),
  status: z.enum(MATERIAL_STATUSES).default('Status not confirmed'),
  required_on_site_date: zDate.optional(),
  planned_delivery_date: zDate.optional(),
  confirmed_delivery_date: zDate.optional(),
  revised_delivery_date: zDate.optional(),
  actual_delivery_date: zDate.optional(),
  delivery_date_note: zText(300).default(''),
  planned_completion_date: zDate.optional(),
  actual_completion_date: zDate.optional(),
  qty_ordered: zQty.optional(),
  qty_delivered: zQty.optional(),
  inspection_status: z.enum(INSPECTION_STATUSES).default(''),
  next_follow_up_date: zDate.optional(),
  document_url: zUrl.default(''),
  notes: zText(4000).default(''),
  is_package: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
});

export function materialRoutes(pool: pg.Pool, notifier: Notifier, timeZone = 'Asia/Qatar') {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'materials.read');
    res.json(await loadMaterials(pool, req.project!.id, req.query.includeArchived === '1'));
  });

  r.post('/', async (req, res) => {
    assertCap(req, 'materials.write');
    const body = parseBody(materialSchema, req);
    assertActualDatesNotFuture(body, todayISO(timeZone));
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertMaterialCategory(c, pid, body.category_id);
      await assertProjectMember(c, pid, body.assigned_contractor_id, ['contractor']);
      if (body.sort_order === undefined) {
        const { rows } = await c.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM material_items WHERE project_id = $1', [pid]);
        body.sort_order = rows[0].n;
      }
      const m = await insertRow(c, 'material_items', { ...body, project_id: pid });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'material', entityId: m.id as string, summary: `Added material line ${m.category} — ${body.description}`, after: m });
      return m;
    });
    res.status(201).json(row);
  });

  r.patch('/:id', async (req, res) => {
    const u = req.user!;
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const full = can(u.role, 'materials.write');
    const contractor = can(u.role, 'materials.contractor');
    if (!full && !contractor) throw forbidden();
    const body = parsePatch(materialSchema.partial(), req) as Record<string, unknown>;
    assertActualDatesNotFuture(body, todayISO(timeZone));
    const out = await withTx(pool, async (c) => {
      const current = await getOwned<Record<string, unknown>>(c, 'material_items', pid, id);
      let patch = body;
      if (!full) {
        if (current.assigned_contractor_id !== u.id) throw forbidden('This material line is not assigned to you');
        const disallowed = Object.keys(body).filter((k) => body[k] !== undefined && !(CONTRACTOR_MATERIAL_FIELDS as readonly string[]).includes(k));
        if (disallowed.length) throw forbidden(`Contractors cannot change: ${disallowed.join(', ')}`);
        patch = Object.fromEntries(Object.entries(body).filter(([k]) => (CONTRACTOR_MATERIAL_FIELDS as readonly string[]).includes(k)));
      } else {
        if (body.assigned_contractor_id !== undefined) {
          await assertProjectMember(c, pid, body.assigned_contractor_id as string | null, ['contractor']);
        }
        if (body.category_id !== undefined && body.category_id !== current.category_id) {
          await assertMaterialCategory(c, pid, body.category_id as string);
        }
      }
      const { before, after } = await patchOwned(c, 'material_items', pid, id, patch);
      const d = diff(before, after);
      const dateChanges = d.changed.filter((k) => DATE_FIELDS.includes(k));
      await audit(c, req, {
        projectId: pid,
        action: dateChanges.length ? 'delivery_date_change' : 'update',
        entityType: 'material', entityId: id,
        summary: `${after.category} — ${after.description}: ${d.changed.join(', ')}`,
        before: d.before, after: d.after,
      });
      return { before, after, dateChanged: dateChanges.length > 0 };
    });
    if (out.dateChanged) notifier.emit(await materialDateEvents(pool, out.before, out.after, u.id).catch(() => []));
    res.json(out.after);
  });

  /**
   * Explicit date reconciliation by an authorised user. The chosen saved date becomes the planned
   * date of the line's current workflow; older fields keep their values (Previous date details).
   * Contractor work never takes a delivery date unless the user picks it here.
   */
  const OWNER_SOURCES = ['planned_delivery_date', 'required_on_site_date', 'confirmed_delivery_date', 'revised_delivery_date'] as const;
  const WORK_SOURCES = ['required_on_site_date', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date'] as const;
  const confirmSchema = z.object({
    workflow: z.enum(['owner', 'contractor']),
    planned_source: z.string().max(40),
    actual_from_delivery: z.boolean().optional(),
  });
  r.post('/:id/confirm-schedule', async (req, res) => {
    assertCap(req, 'materials.write');
    const id = uuidParam(req, 'id');
    const pid = req.project!.id;
    const body = parseBody(confirmSchema, req);
    const out = await withTx(pool, async (c) => {
      const current = await getOwned<Record<string, any>>(c, 'material_items', pid, id, { forUpdate: true });
      if (current.archived_at) throw badRequest('This material line is archived. Restore it first.');
      if (current.supply_responsibility !== body.workflow) {
        throw badRequest(current.supply_responsibility === 'needs_confirmation'
          ? 'Select and save Owner supply or Contractor supply first, then confirm the schedule.'
          : 'The saved supply responsibility has changed. Save the responsibility first, then confirm the schedule.');
      }
      const val = (f: string) => (current[f] ? String(current[f]).slice(0, 10) : null);
      const patch: Record<string, unknown> = {};
      let note: string;
      if (body.workflow === 'owner') {
        const src = body.planned_source;
        if (src === 'none') {
          if (val('planned_delivery_date')) throw badRequest('Choose the planned delivery date to keep.');
          note = 'planned delivery left blank';
        } else {
          if (!(OWNER_SOURCES as readonly string[]).includes(src)) throw badRequest('Choose one of the saved delivery dates.');
          const d = val(src);
          if (!d) throw badRequest(`${DATE_FIELD_LABELS[src as DateField]} has no saved date.`);
          if (d !== val('planned_delivery_date')) patch.planned_delivery_date = d;
          note = `planned delivery ${d} (from ${DATE_FIELD_LABELS[src as DateField].toLowerCase()})`;
        }
        patch.delivery_schedule_confirmed_at = new Date();
      } else {
        const src = body.planned_source;
        if (src === 'none') {
          note = 'planned completion not taken from older dates';
        } else {
          if (!(WORK_SOURCES as readonly string[]).includes(src)) throw badRequest('Choose one of the saved dates, or none.');
          const d = val(src);
          if (!d) throw badRequest(`${DATE_FIELD_LABELS[src as DateField]} has no saved date.`);
          if (d !== val('planned_completion_date')) patch.planned_completion_date = d;
          note = `planned completion ${d} (from ${DATE_FIELD_LABELS[src as DateField].toLowerCase()})`;
        }
        if (body.actual_from_delivery) {
          const a = val('actual_delivery_date');
          if (!a) throw badRequest('There is no actual delivery date to use.');
          if (val('actual_completion_date') && val('actual_completion_date') !== a) throw badRequest('An actual completion date is already saved. Edit it in the form instead.');
          patch.actual_completion_date = a;
          note += `; actual completion ${a} (from actual delivery)`;
        }
        patch.work_schedule_confirmed_at = new Date();
      }
      const { before, after } = await patchOwned(c, 'material_items', pid, id, patch);
      const d = diff(before, after);
      await audit(c, req, {
        projectId: pid, action: 'schedule_confirmed', entityType: 'material', entityId: id,
        summary: `${after.category} — ${after.description}: ${body.workflow === 'owner' ? 'delivery' : 'work'} schedule confirmed — ${note}`,
        before: d.before, after: d.after,
      });
      return { before, after };
    });
    const b = materialSchedule(out.before as never).deadline;
    const a = materialSchedule(out.after as never).deadline;
    if (b?.date !== a?.date || b?.label !== a?.label) notifier.emit(await materialDateEvents(pool, out.before, out.after, req.user!.id).catch(() => []));
    res.json(out.after);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/:id/${action}`, async (req, res) => {
      assertCap(req, 'materials.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        const { after } = await patchOwned(c, 'material_items', pid, id, { archived_at: action === 'archive' ? new Date() : null });
        await audit(c, req, { projectId: pid, action, entityType: 'material', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} material line ${after.description}` });
        return after;
      });
      res.json(out);
    });
  }

  // ---- category scope notes
  const scopeSchema = z.object({
    category_id: z.string().uuid(),
    owner_supply: zText(4000).default(''),
    contractor_scope: zText(4000).default(''),
    source_label: zText(200).default(''),
  });
  r.post('/scope-notes', async (req, res) => {
    assertCap(req, 'materials.write');
    const body = parseBody(scopeSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      const cat = await getOwned<{ name: string }>(c, 'material_categories', pid, body.category_id).catch(() => { throw badRequest('Material category not found in this project'); });
      const n = await insertRow(c, 'material_scope_notes', { ...body, category: cat.name, project_id: pid });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'material_scope_note', entityId: n.id as string, summary: `Added scope note for ${cat.name}`, after: n });
      return n;
    });
    res.status(201).json(row);
  });
  r.patch('/scope-notes/:id', async (req, res) => {
    assertCap(req, 'materials.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(scopeSchema.omit({ category_id: true }).partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const { before, after } = await patchOwned(c, 'material_scope_notes', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'material_scope_note', entityId: id, summary: `Edited scope note for ${after.category}`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  return r;
}
