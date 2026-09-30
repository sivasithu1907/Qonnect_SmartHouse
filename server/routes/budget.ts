import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, parseBody, parsePatch, uuidParam, zMoney, zQty, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { getOwned, insertRow, patchOwned } from '../lib/crud';
import { miscAllowance, sumMoney } from '../../shared/calc';

// The budget uses ONE amount per item: the approved / finalized amount. Legacy source and
// variant estimate columns may still exist in older databases but are never read or returned.
export const BUDGET_ITEM_COLUMNS = [
  'id', 'project_id', 'category_id', 'name', 'description', 'quantity', 'unit', 'source_label',
  'approved_amount', 'approved_by', 'approved_at', 'notes', 'sort_order', 'archived_at', 'created_at', 'updated_at',
] as const;
const ITEM_SELECT = BUDGET_ITEM_COLUMNS.join(', ');

/** Strips any column that is not part of the public budget item shape. */
export function publicBudgetItem(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of BUDGET_ITEM_COLUMNS) out[k] = row[k];
  return out;
}

export async function loadBudget(db: pg.Pool | pg.PoolClient, projectId: string) {
  const [cats, items, paidByItem, schedByItem] = await Promise.all([
    db.query('SELECT * FROM budget_categories WHERE project_id = $1 ORDER BY sort_order, created_at', [projectId]),
    db.query(`SELECT ${ITEM_SELECT} FROM budget_items WHERE project_id = $1 ORDER BY sort_order, created_at`, [projectId]),
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
  return { categories: cats.rows, items: itemRows };
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
      approved: approvedVals.length ? sumMoney(approvedVals) : null,
      scheduled: sumMoney(its.map((i) => i.scheduled_amount)),
      paid: sumMoney(its.map((i) => i.paid_amount)),
      itemCount: its.length,
      approvedItemCount: approvedVals.length,
    };
  });
  const misc = miscAllowance(b.categories, b.items.filter((i) => activeCatIds.has(i.category_id)), project.misc_percentage as number);
  const approvedItems = activeItems.filter((i) => i.approved_amount !== null);
  return {
    byCategory,
    misc,
    approvedCommitments: sumMoney(approvedItems.map((i) => i.approved_amount)),
    approvedItemCount: approvedItems.length,
    itemCount: activeItems.length,
    scheduled: sumMoney(activeItems.map((i) => i.scheduled_amount)),
    paid: sumMoney(activeItems.map((i) => i.paid_amount)),
  };
}

const itemSchema = z.object({
  category_id: z.string().uuid(),
  name: zText(200).min(1),
  description: zText(4000).default(''),
  quantity: zQty.optional(),
  unit: zText(40).default(''),
  source_label: zText(200).default(''),
  approved_amount: zMoney.optional(),
  notes: zText(4000).default(''),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

async function assertBudgetCategory(c: pg.PoolClient, projectId: string, categoryId: string, forNewItem: boolean) {
  const { rows } = await c.query('SELECT archived_at FROM budget_categories WHERE id = $1 AND project_id = $2', [categoryId, projectId]);
  if (!rows[0]) throw badRequest('Category not found in this project');
  if (forNewItem && rows[0].archived_at) throw badRequest('This category is archived. Restore it in Manage Categories or choose another category.');
}

export function budgetRoutes(pool: pg.Pool) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'budget.read');
    const b = await loadBudget(pool, req.project!.id);
    res.json({ ...b, summary: budgetSummary(req.project!, b) });
  });

  // ---- items (categories are managed in routes/categories.ts)
  r.post('/items', async (req, res) => {
    assertCap(req, 'budget.write');
    const body = parseBody(itemSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertBudgetCategory(c, pid, body.category_id, true);
      const approved = body.approved_amount ?? null;
      if (body.sort_order === undefined) {
        const { rows } = await c.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM budget_items WHERE category_id = $1', [body.category_id]);
        body.sort_order = rows[0].n;
      }
      const item = publicBudgetItem(await insertRow(c, 'budget_items', {
        ...body, project_id: pid, approved_amount: approved,
        approved_by: approved !== null ? req.user!.id : null, approved_at: approved !== null ? new Date() : null,
      }));
      await audit(c, req, {
        projectId: pid, action: approved !== null ? 'approve' : 'create', entityType: 'budget_item', entityId: item.id as string,
        summary: `Added budget item ${body.name}${approved !== null ? ` with approved amount ${approved}` : ''}`, after: item,
      });
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
      const current = await getOwned<Record<string, unknown>>(c, 'budget_items', pid, id);
      if (body.category_id && body.category_id !== current.category_id) await assertBudgetCategory(c, pid, body.category_id, true);
      const patch: Record<string, unknown> = { ...body };
      let approvalChanged = false;
      if (body.approved_amount !== undefined && body.approved_amount !== current.approved_amount) {
        approvalChanged = true;
        patch.approved_by = body.approved_amount === null ? null : req.user!.id;
        patch.approved_at = body.approved_amount === null ? null : new Date();
      }
      const res0 = await patchOwned(c, 'budget_items', pid, id, patch);
      const before = publicBudgetItem(res0.before);
      const after = publicBudgetItem(res0.after);
      const d = diff(before, after);
      await audit(c, req, {
        projectId: pid,
        action: approvalChanged ? (after.approved_amount === null ? 'unapprove' : 'approve') : 'update',
        entityType: 'budget_item', entityId: id,
        summary: approvalChanged
          ? `Approved / finalized amount for ${after.name}: ${before.approved_amount ?? 'blank'} → ${after.approved_amount ?? 'blank'}`
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
        return publicBudgetItem(after);
      });
      res.json(out);
    });
  }

  return r;
}
