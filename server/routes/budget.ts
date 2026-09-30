import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, parseBody, parsePatch, uuidParam, zMoney, zQty, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { miscAllowance, sumMoney, toCents, fromCents } from '../../shared/calc';

export async function loadBudget(db: pg.Pool | pg.PoolClient, projectId: string) {
  const [cats, items, refs, paidByItem, schedByItem] = await Promise.all([
    db.query('SELECT * FROM budget_categories WHERE project_id = $1 ORDER BY sort_order, created_at', [projectId]),
    db.query('SELECT * FROM budget_items WHERE project_id = $1 ORDER BY sort_order, created_at', [projectId]),
    db.query('SELECT * FROM source_references WHERE project_id = $1 ORDER BY sort_order', [projectId]),
    db.query(
      `SELECT m.budget_item_id, COALESCE(SUM(t.amount),0) AS paid
         FROM payment_transactions t JOIN payment_milestones m ON m.id = t.milestone_id
        WHERE t.project_id = $1 AND t.archived_at IS NULL AND m.archived_at IS NULL AND m.budget_item_id IS NOT NULL
        GROUP BY m.budget_item_id`,
      [projectId],
    ),
    db.query(
      `SELECT budget_item_id, COALESCE(SUM(scheduled_amount),0) AS scheduled
         FROM payment_milestones WHERE project_id = $1 AND archived_at IS NULL AND status <> 'cancelled' AND budget_item_id IS NOT NULL
        GROUP BY budget_item_id`,
      [projectId],
    ),
  ]);
  const paid = new Map(paidByItem.rows.map((r) => [r.budget_item_id, Number(r.paid)]));
  const sched = new Map(schedByItem.rows.map((r) => [r.budget_item_id, Number(r.scheduled)]));
  const itemRows = items.rows.map((i) => ({ ...i, paid_amount: paid.get(i.id) ?? 0, scheduled_amount: sched.get(i.id) ?? 0 }));
  return { categories: cats.rows, items: itemRows, references: refs.rows };
}

export function budgetSummary(project: Record<string, unknown>, b: Awaited<ReturnType<typeof loadBudget>>) {
  const activeCats = b.categories.filter((c) => !c.archived_at);
  const activeCatIds = new Set(activeCats.map((c) => c.id));
  const activeItems = b.items.filter((i) => !i.archived_at && activeCatIds.has(i.category_id));
  const byCategory = activeCats.map((c) => {
    const its = activeItems.filter((i) => i.category_id === c.id);
    const approvedVals = its.map((i) => i.approved_amount).filter((v) => v !== null);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      source_amount: its.some((i) => i.source_amount !== null) ? sumMoney(its.map((i) => i.source_amount)) : null,
      source_variant_a: its.some((i) => i.source_variant_a !== null) ? sumMoney(its.map((i) => i.source_variant_a)) : null,
      source_variant_b: its.some((i) => i.source_variant_b !== null) ? sumMoney(its.map((i) => i.source_variant_b)) : null,
      approved: approvedVals.length ? sumMoney(approvedVals) : null,
      scheduled: sumMoney(its.map((i) => i.scheduled_amount)),
      paid: sumMoney(its.map((i) => i.paid_amount)),
    };
  });
  const misc = miscAllowance(b.categories, b.items.filter((i) => activeCatIds.has(i.category_id)), project.misc_basis as never, project.misc_percentage as number);
  const approvedItems = activeItems.filter((i) => i.approved_amount !== null);
  return {
    byCategory,
    misc,
    approvedCommitments: sumMoney(approvedItems.map((i) => i.approved_amount)),
    approvedItemCount: approvedItems.length,
    itemCount: activeItems.length,
    fixedSourceSubtotal: fromCents(
      activeItems.filter((i) => activeCats.find((c) => c.id === i.category_id)?.kind === 'fixed').reduce((a, i) => a + toCents(i.source_amount), 0),
    ),
  };
}

const categorySchema = z.object({
  name: zText(160).min(1),
  kind: z.enum(['finishing', 'fixed', 'other']).default('finishing'),
  include_in_misc_basis: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
  source_label: zText(200).default(''),
  notes: zText(4000).default(''),
});

const itemSchema = z.object({
  category_id: z.string().uuid(),
  name: zText(200).min(1),
  description: zText(4000).default(''),
  quantity: zQty.optional(),
  unit: zText(40).default(''),
  source_amount: zMoney.optional(),
  source_variant_a: zMoney.optional(),
  source_variant_b: zMoney.optional(),
  source_status: zText(200).default(''),
  source_label: zText(200).default(''),
  approved_amount: zMoney.optional(),
  notes: zText(4000).default(''),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

export function budgetRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'budget.read');
    const b = await loadBudget(pool, req.project!.id);
    res.json({ ...b, summary: budgetSummary(req.project!, b) });
  });

  // ---- categories
  r.post('/categories', async (req, res) => {
    assertCap(req, 'budget.write');
    const body = parseBody(categorySchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      const cat = await insertRow(c, 'budget_categories', {
        ...body, project_id: pid, include_in_misc_basis: body.include_in_misc_basis ?? body.kind === 'finishing',
      });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'budget_category', entityId: cat.id as string, summary: `Added budget category ${body.name}`, after: cat });
      return cat;
    });
    res.status(201).json(row);
  });

  r.patch('/categories/:id', async (req, res) => {
    assertCap(req, 'budget.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(categorySchema.partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const { before, after } = await patchOwned(c, 'budget_categories', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'budget_category', entityId: id, summary: `Edited budget category ${after.name} (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/categories/:id/${action}`, async (req, res) => {
      assertCap(req, 'budget.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        const { after } = await patchOwned(c, 'budget_categories', pid, id, { archived_at: action === 'archive' ? new Date() : null });
        await audit(c, req, { projectId: pid, action, entityType: 'budget_category', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} budget category ${after.name}` });
        return after;
      });
      res.json(out);
    });
  }

  // ---- items
  r.post('/items', async (req, res) => {
    assertCap(req, 'budget.write');
    const body = parseBody(itemSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertSameProject(c, 'budget_categories', pid, body.category_id, 'Category');
      const approved = body.approved_amount ?? null;
      const item = await insertRow(c, 'budget_items', {
        ...body, project_id: pid, approved_amount: approved,
        approved_by: approved !== null ? req.user!.id : null, approved_at: approved !== null ? new Date() : null,
      });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'budget_item', entityId: item.id as string, summary: `Added budget item ${body.name}`, after: item });
      return item;
    });
    res.status(201).json(row);
  });

  r.patch('/items/:id', async (req, res) => {
    assertCap(req, 'budget.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(itemSchema.partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      if (body.category_id) await assertSameProject(c, 'budget_categories', pid, body.category_id, 'Category');
      const current = await getOwned<Record<string, unknown>>(c, 'budget_items', pid, id);
      const patch: Record<string, unknown> = { ...body };
      let approvalChanged = false;
      if (body.approved_amount !== undefined && body.approved_amount !== current.approved_amount) {
        approvalChanged = true;
        patch.approved_by = body.approved_amount === null ? null : req.user!.id;
        patch.approved_at = body.approved_amount === null ? null : new Date();
      }
      const { before, after } = await patchOwned(c, 'budget_items', pid, id, patch);
      const d = diff(before, after);
      await audit(c, req, {
        projectId: pid,
        action: approvalChanged ? (after.approved_amount === null ? 'unapprove' : 'approve') : 'update',
        entityType: 'budget_item', entityId: id,
        summary: approvalChanged
          ? `Approved amount for ${after.name}: ${before.approved_amount ?? 'blank'} → ${after.approved_amount ?? 'blank'}`
          : `Edited budget item ${after.name} (${d.changed.join(', ')})`,
        before: d.before, after: d.after,
      });
      return after;
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/items/:id/${action}`, async (req, res) => {
      assertCap(req, 'budget.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        if (action === 'archive') {
          const used = await c.query(
            `SELECT 1 FROM payment_milestones WHERE budget_item_id = $1 AND project_id = $2 AND archived_at IS NULL LIMIT 1`, [id, pid]);
          if (used.rowCount) throw badRequest('This item is linked to active payment milestones. Re-link or archive those first.');
        }
        const { after } = await patchOwned(c, 'budget_items', pid, id, { archived_at: action === 'archive' ? new Date() : null });
        await audit(c, req, { projectId: pid, action, entityType: 'budget_item', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} budget item ${after.name}` });
        return after;
      });
      res.json(out);
    });
  }

  r.patch('/references/:id', async (req, res) => {
    assertCap(req, 'budget.write');
    const id = uuidParam(req, 'id');
    const body = parseBody(z.object({ review_status: z.enum(['Needs review', 'Reviewed', 'Superseded']).optional(), note: zText(4000).optional() }), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const { before, after } = await patchOwned(c, 'source_references', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'source_reference', entityId: id, summary: `Updated source reference ${after.label}`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  return r;
}
