// Contracts & Documents — project-scoped contract register.
//   /api/projects/:projectId/contracts                       GET list · POST create
//   /api/projects/:projectId/contracts/:id                   GET details (summary, amendments, linked payments) · PATCH
//   /api/projects/:projectId/contracts/:id/archive|restore   POST
//   /api/projects/:projectId/contracts/:id/amendments        POST
//   /api/projects/:projectId/contracts/amendments/:aid       PATCH · /archive · /restore
//
// Contract files use the existing secure attachments system (entity_type 'contract' / 'contract_amendment').
// Saving a contract or its value NEVER changes budget amounts, creates payment milestones or marks
// anything paid. Payment milestones reference a contract from the Payments page (contract_id).
// Financial fields (contract value, linked payments) follow the existing payments.read rule and the
// linked budget item name follows budget.read.
import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, parseBody, parsePatch, uuidParam, zDate, zMoney, zText, zUrl } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { can } from '../permissions';
import { CONTRACT_STATUSES } from '../../shared/constants';
import { contractFinance } from '../../shared/contractFinance';
import { loadPayments } from './payments';
import { checkDirectoryLinks, directoryJoin, directoryLinkFields, directorySelect } from '../lib/directoryLinks';

const uuidOrNull = z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable());

const contractSchema = z.object({
  title: zText(300).min(1, 'Title is required'),
  category_id: z.string().uuid('Category is required'),
  company_name: zText(200).min(1, 'Contractor / company name is required'),
  reference: zText(120).default(''),
  signed_date: zDate.optional(),
  contract_value: zMoney.optional(),
  status: z.enum(CONTRACT_STATUSES).default('Draft'),
  notes: zText(4000).default(''),
  drive_url: zUrl.default(''),
  budget_item_id: uuidOrNull.optional(),
  ...directoryLinkFields,
});

const amendmentSchema = z.object({
  amendment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Amendment date is required (YYYY-MM-DD)'),
  description: zText(2000).min(1, 'Description is required'),
  reference: zText(120).default(''),
  notes: zText(4000).default(''),
});

export interface Access { finance: boolean; budget: boolean }
export const accessFor = (req: Request): Access => ({ finance: can(req.user!.role, 'payments.read'), budget: can(req.user!.role, 'budget.read') });

/** Removes fields the user's role may not see. Financial values are dropped, not zeroed. */
export function redactContract<T extends Record<string, unknown>>(row: T, a: Access): T {
  const out: Record<string, unknown> = { ...row };
  if (!a.finance) {
    delete out.contract_value;
    delete out.payments;
  }
  if (!a.budget) {
    delete out.budget_item_name;
    delete out.budget_item_id;
  }
  return out as T;
}

async function loadContracts(db: pg.Pool | pg.PoolClient, pid: string, includeArchived: boolean, id?: string) {
  const { rows } = await db.query(
    `SELECT k.*, cc.name AS category_name, cc.sort_order AS category_sort, bi.name AS budget_item_name,
            u.name AS created_by_name, ${directorySelect('k')},
            (SELECT count(*)::int FROM attachments a WHERE a.project_id = k.project_id AND a.entity_type = 'contract' AND a.entity_id = k.id AND a.archived_at IS NULL) AS attachment_count,
            (SELECT count(*)::int FROM contract_amendments x WHERE x.contract_id = k.id AND x.archived_at IS NULL) AS amendment_count
       FROM contracts k
       JOIN contract_categories cc ON cc.id = k.category_id
       LEFT JOIN budget_items bi ON bi.id = k.budget_item_id AND bi.project_id = k.project_id
       LEFT JOIN users u ON u.id = k.created_by
       ${directoryJoin('k')}
      WHERE k.project_id = $1 AND ($2 OR k.archived_at IS NULL) AND ($3::uuid IS NULL OR k.id = $3)
      ORDER BY cc.sort_order, k.signed_date DESC NULLS LAST, k.created_at DESC`,
    [pid, includeArchived, id ?? null],
  );
  return rows;
}

type PaymentsData = Awaited<ReturnType<typeof loadPayments>>;
type Milestone = PaymentsData['milestones'][number];

/**
 * Contract finance for one contract from its explicitly linked milestones (archived included, so
 * money already paid is never dropped). See shared/contractFinance.ts for the definitions.
 */
const financeFor = (k: Record<string, any>, linked: Milestone[]) => contractFinance(k.contract_value, linked);

async function assertCategory(c: pg.PoolClient, pid: string, categoryId: string, isNewChoice: boolean) {
  await assertSameProject(c, 'contract_categories', pid, categoryId, 'Contract category');
  if (!isNewChoice) return;
  const { rows } = await c.query('SELECT archived_at FROM contract_categories WHERE id = $1', [categoryId]);
  if (rows[0]?.archived_at) throw badRequest('That contract category is archived. Choose another category or restore it first.');
}

export function contractRoutes(pool: pg.Pool, timeZone: string) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'contracts.read');
    const pid = req.project!.id;
    const a = accessFor(req);
    const rows = await loadContracts(pool, pid, req.query.includeArchived === '1');
    const byContract = new Map<string, Milestone[]>();
    if (a.finance) {
      const p = await loadPayments(pool, pid, timeZone, true); // archived milestones too: their transfers stay paid
      for (const m of p.milestones) {
        if (!m.contract_id) continue;
        byContract.set(m.contract_id, [...(byContract.get(m.contract_id) ?? []), m]);
      }
    }
    res.json({
      contracts: rows.map((k) => redactContract({ ...k, payments: financeFor(k, byContract.get(k.id) ?? []) }, a)),
      access: a,
    });
  });

  r.get('/:id', async (req, res) => {
    assertCap(req, 'contracts.read');
    const pid = req.project!.id;
    const id = uuidParam(req, 'id');
    await getOwned(pool, 'contracts', pid, id); // 404 for other projects
    const a = accessFor(req);
    const [k] = await loadContracts(pool, pid, true, id);
    const { rows: amendments } = await pool.query(
      `SELECT x.*, u.name AS created_by_name,
              (SELECT count(*)::int FROM attachments a WHERE a.project_id = x.project_id AND a.entity_type = 'contract_amendment' AND a.entity_id = x.id AND a.archived_at IS NULL) AS attachment_count
         FROM contract_amendments x LEFT JOIN users u ON u.id = x.created_by
        WHERE x.project_id = $1 AND x.contract_id = $2
        ORDER BY x.amendment_date, x.created_at`,
      [pid, id],
    );
    let payments: { summary: ReturnType<typeof financeFor>; milestones: unknown[] } | undefined;
    if (a.finance) {
      const p = await loadPayments(pool, pid, timeZone, true);
      const linked = p.milestones.filter((m) => m.contract_id === id);
      payments = {
        summary: financeFor(k, linked),
        milestones: linked.map((m) => ({
          id: m.id, payee_name: m.payee_name, description: m.description, due_date: m.due_date, status: m.status,
          scheduled_amount: m.scheduled_amount, archived_at: m.archived_at, balance: m.balance,
        })),
      };
    }
    res.json(redactContract({ ...k, amendments, payments }, a));
  });

  r.post('/', async (req, res) => {
    assertCap(req, 'contracts.write');
    const body = parseBody(contractSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertCategory(c, pid, body.category_id, true);
      await assertSameProject(c, 'budget_items', pid, body.budget_item_id, 'Budget item');
      await checkDirectoryLinks(c, pid, body);
      const k = await insertRow(c, 'contracts', {
        ...body, signed_date: body.signed_date ?? null, contract_value: body.contract_value ?? null,
        budget_item_id: body.budget_item_id ?? null, project_id: pid, created_by: req.user!.id,
      });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'contract', entityId: k.id as string, summary: `Added contract "${k.title}" with ${k.company_name}`, after: k });
      return k;
    });
    res.status(201).json(row);
  });

  r.patch('/:id', async (req, res) => {
    assertCap(req, 'contracts.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(contractSchema.partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const cur = await getOwned<Record<string, unknown>>(c, 'contracts', pid, id, { forUpdate: true });
      if (body.category_id) await assertCategory(c, pid, body.category_id, body.category_id !== cur.category_id);
      if (body.budget_item_id) await assertSameProject(c, 'budget_items', pid, body.budget_item_id, 'Budget item');
      await checkDirectoryLinks(c, pid, body as Record<string, unknown>, cur as never);
      const { before, after } = await patchOwned(c, 'contracts', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'contract', entityId: id, summary: `Edited contract "${after.title}" (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/:id/${action}`, async (req, res) => {
      assertCap(req, 'contracts.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        const { after } = await patchOwned(c, 'contracts', pid, id, { archived_at: action === 'archive' ? new Date() : null });
        await audit(c, req, { projectId: pid, action, entityType: 'contract', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} contract "${after.title}"` });
        return after;
      });
      res.json(out);
    });
  }

  // ---- amendments (recorded separately; the original contract and its signed file stay unchanged)
  r.post('/:id/amendments', async (req, res) => {
    assertCap(req, 'contracts.write');
    const id = uuidParam(req, 'id');
    const body = parseBody(amendmentSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      const k = await getOwned<Record<string, unknown>>(c, 'contracts', pid, id);
      if (k.archived_at) throw badRequest('This contract is archived. Restore it before adding amendments.');
      const x = await insertRow(c, 'contract_amendments', { ...body, project_id: pid, contract_id: id, created_by: req.user!.id });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'contract_amendment', entityId: x.id as string, summary: `Recorded amendment dated ${body.amendment_date} for contract "${k.title}"`, after: x });
      return x;
    });
    res.status(201).json(row);
  });

  r.patch('/amendments/:aid', async (req, res) => {
    assertCap(req, 'contracts.write');
    const aid = uuidParam(req, 'aid');
    const body = parsePatch(amendmentSchema.partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      const { before, after } = await patchOwned(c, 'contract_amendments', pid, aid, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'contract_amendment', entityId: aid, summary: `Edited contract amendment dated ${after.amendment_date} (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/amendments/:aid/${action}`, async (req, res) => {
      assertCap(req, 'contracts.write');
      const aid = uuidParam(req, 'aid');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        const { after } = await patchOwned(c, 'contract_amendments', pid, aid, { archived_at: action === 'archive' ? new Date() : null });
        await audit(c, req, { projectId: pid, action, entityType: 'contract_amendment', entityId: aid, summary: `${action === 'archive' ? 'Archived' : 'Restored'} contract amendment dated ${after.amendment_date}` });
        return after;
      });
      res.json(out);
    });
  }

  return r;
}
