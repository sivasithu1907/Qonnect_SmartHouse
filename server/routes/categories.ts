// Centralized, project-scoped category management (admins).
//   /api/projects/:projectId/categories            GET  both lists (+ usage counts)
//   /api/projects/:projectId/categories/budget      POST / PATCH :id / POST reorder / archive / restore / DELETE :id
//   /api/projects/:projectId/categories/material    same
// Budget categories group budget items; material categories group material supply lines.
// A category that is used by any record (including archived ones) cannot be deleted — archive it instead.
import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, conflict, forbidden, parseBody, parsePatch, uuidParam, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { getOwned, insertRow, patchOwned } from '../lib/crud';
import { can } from '../permissions';

type Kind = 'budget' | 'material';
const TABLE: Record<Kind, string> = { budget: 'budget_categories', material: 'material_categories' };
const zName = zText(160).min(1, 'Name is required');

export async function loadCategories(db: pg.Pool | pg.PoolClient, projectId: string) {
  const [budget, material] = await Promise.all([
    db.query(
      `SELECT c.*,
              (SELECT count(*)::int FROM budget_items i WHERE i.category_id = c.id) AS usage_count,
              (SELECT count(*)::int FROM budget_items i WHERE i.category_id = c.id AND i.archived_at IS NULL) AS active_count
         FROM budget_categories c WHERE c.project_id = $1 ORDER BY c.sort_order, c.created_at`,
      [projectId],
    ),
    db.query(
      `SELECT c.*,
              (SELECT count(*)::int FROM material_items m WHERE m.category_id = c.id)
                + (SELECT count(*)::int FROM material_scope_notes n WHERE n.category_id = c.id) AS usage_count,
              (SELECT count(*)::int FROM material_items m WHERE m.category_id = c.id AND m.archived_at IS NULL) AS active_count
         FROM material_categories c WHERE c.project_id = $1 ORDER BY c.sort_order, c.created_at`,
      [projectId],
    ),
  ]);
  return { budget: budget.rows, material: material.rows };
}

async function assertUniqueName(c: pg.PoolClient, kind: Kind, projectId: string, name: string, exceptId?: string) {
  const { rowCount } = await c.query(
    `SELECT 1 FROM ${TABLE[kind]} WHERE project_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND ($3::uuid IS NULL OR id <> $3)`,
    [projectId, name, exceptId ?? null],
  );
  if (rowCount) throw conflict(`A ${kind} category named "${name.trim()}" already exists in this project (it may be archived).`);
}

async function usage(c: pg.PoolClient, kind: Kind, id: string) {
  if (kind === 'budget') {
    const { rows } = await c.query('SELECT count(*)::int AS n FROM budget_items WHERE category_id = $1', [id]);
    return { total: rows[0].n as number, detail: `${rows[0].n} budget item(s)` };
  }
  const { rows } = await c.query(
    `SELECT (SELECT count(*)::int FROM material_items WHERE category_id = $1) AS lines,
            (SELECT count(*)::int FROM material_scope_notes WHERE category_id = $1) AS notes`,
    [id],
  );
  const parts = [`${rows[0].lines} material line(s)`];
  if (rows[0].notes) parts.push('its scope notes');
  return { total: rows[0].lines + rows[0].notes, detail: parts.join(' and ') };
}

const budgetCreate = z.object({
  name: zName,
  kind: z.enum(['finishing', 'fixed', 'other']).default('finishing'),
  include_in_misc_basis: z.boolean().optional(),
  source_label: zText(200).default(''),
  notes: zText(4000).default(''),
});
const materialCreate = z.object({ name: zName });

export function categoryRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    const u = req.user!;
    if (!can(u.role, 'budget.read') && !can(u.role, 'materials.read')) throw forbidden();
    const all = await loadCategories(pool, req.project!.id);
    res.json({ budget: can(u.role, 'budget.read') ? all.budget : [], material: can(u.role, 'materials.read') ? all.material : [] });
  });

  for (const kind of ['budget', 'material'] as const) {
    const table = TABLE[kind];
    const entity = `${kind}_category`;
    const guard = (req: Request) => assertCap(req, 'categories.manage');

    r.post(`/${kind}`, async (req, res) => {
      guard(req);
      const body = parseBody(kind === 'budget' ? budgetCreate : materialCreate, req) as Record<string, unknown> & { name: string };
      const pid = req.project!.id;
      const row = await withTx(pool, async (c) => {
        await assertUniqueName(c, kind, pid, body.name);
        const { rows } = await c.query(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM ${table} WHERE project_id = $1`, [pid]);
        const data: Record<string, unknown> = { ...body, name: body.name.trim(), project_id: pid, sort_order: rows[0].n };
        if (kind === 'budget') data.include_in_misc_basis = body.include_in_misc_basis ?? body.kind === 'finishing';
        const cat = await insertRow(c, table, data);
        await audit(c, req, { projectId: pid, action: 'create', entityType: entity, entityId: cat.id as string, summary: `Added ${kind} category ${cat.name}`, after: cat });
        return cat;
      });
      res.status(201).json(row);
    });

    r.patch(`/${kind}/:id`, async (req, res) => {
      guard(req);
      const id = uuidParam(req, 'id');
      const body = parsePatch((kind === 'budget' ? budgetCreate : materialCreate).partial(), req) as Record<string, unknown>;
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        if (typeof body.name === 'string') {
          body.name = body.name.trim();
          await assertUniqueName(c, kind, pid, body.name as string, id);
        }
        const { before, after } = await patchOwned(c, table, pid, id, body);
        if (kind === 'material' && before.name !== after.name) {
          // keep the denormalised category name on existing lines / scope notes in step (records are preserved)
          await c.query('UPDATE material_items SET category = $2 WHERE category_id = $1', [id, after.name]);
          await c.query('UPDATE material_scope_notes SET category = $2 WHERE category_id = $1', [id, after.name]);
        }
        const d = diff(before, after);
        await audit(c, req, {
          projectId: pid, action: 'update', entityType: entity, entityId: id,
          summary: before.name !== after.name ? `Renamed ${kind} category "${before.name}" → "${after.name}"` : `Edited ${kind} category ${after.name} (${d.changed.join(', ')})`,
          before: d.before, after: d.after,
        });
        return after;
      });
      res.json(out);
    });

    r.post(`/${kind}/reorder`, async (req, res) => {
      guard(req);
      const { ids } = parseBody(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }), req);
      const pid = req.project!.id;
      if (new Set(ids).size !== ids.length) throw badRequest('Duplicate ids');
      await withTx(pool, async (c) => {
        const { rows } = await c.query(`SELECT id, name, sort_order FROM ${table} WHERE project_id = $1 ORDER BY sort_order, created_at`, [pid]);
        const known = new Set(rows.map((x) => x.id));
        if (ids.some((x) => !known.has(x)) || ids.length !== rows.length) {
          throw badRequest('Send every category of this list exactly once, in the new order');
        }
        for (let i = 0; i < ids.length; i++) {
          await c.query(`UPDATE ${table} SET sort_order = $3, updated_at = now() WHERE id = $1 AND project_id = $2`, [ids[i], pid, i + 1]);
        }
        const byId = new Map(rows.map((x) => [x.id, x.name]));
        await audit(c, req, {
          projectId: pid, action: 'reorder', entityType: entity, summary: `Reordered ${kind} categories`,
          before: rows.map((x) => x.name), after: ids.map((x) => byId.get(x)),
        });
      });
      res.json(await loadCategories(pool, pid).then((x) => x[kind]));
    });

    for (const action of ['archive', 'restore'] as const) {
      r.post(`/${kind}/:id/${action}`, async (req, res) => {
        guard(req);
        const id = uuidParam(req, 'id');
        const pid = req.project!.id;
        const out = await withTx(pool, async (c) => {
          const { after } = await patchOwned(c, table, pid, id, { archived_at: action === 'archive' ? new Date() : null });
          await audit(c, req, { projectId: pid, action, entityType: entity, entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} ${kind} category ${after.name}` });
          return after;
        });
        res.json(out);
      });
    }

    r.delete(`/${kind}/:id`, async (req, res) => {
      guard(req);
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      await withTx(pool, async (c) => {
        const cat = await getOwned<Record<string, unknown>>(c, table, pid, id, { forUpdate: true });
        const u = await usage(c, kind, id);
        if (u.total > 0) {
          throw conflict(`"${cat.name}" cannot be deleted because it is used by ${u.detail} (including archived records). Archive the category instead — existing records stay unchanged and it disappears from new-entry dropdowns.`);
        }
        await c.query(`DELETE FROM ${table} WHERE id = $1 AND project_id = $2`, [id, pid]);
        await audit(c, req, { projectId: pid, action: 'delete', entityType: entity, entityId: id, summary: `Deleted unused ${kind} category ${cat.name}`, before: cat });
      });
      res.json({ ok: true });
    });
  }

  return r;
}
