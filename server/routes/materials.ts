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

const DATE_FIELDS = ['required_on_site_date', 'planned_delivery_date', 'confirmed_delivery_date', 'revised_delivery_date', 'actual_delivery_date'];

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
  qty_ordered: zQty.optional(),
  qty_delivered: zQty.optional(),
  inspection_status: z.enum(INSPECTION_STATUSES).default(''),
  next_follow_up_date: zDate.optional(),
  document_url: zUrl.default(''),
  notes: zText(4000).default(''),
  is_package: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
});

export function materialRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'materials.read');
    res.json(await loadMaterials(pool, req.project!.id, req.query.includeArchived === '1'));
  });

  r.post('/', async (req, res) => {
    assertCap(req, 'materials.write');
    const body = parseBody(materialSchema, req);
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
      return after;
    });
    res.json(out);
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
