import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { assertCap } from '../auth';
import { badRequest, conflict, HttpError, parseBody, parsePatch, uuidParam, zDate, zText } from '../lib/http';
import { withTx } from '../db';
import { audit, diff } from '../audit';
import { assertSameProject, getOwned, insertRow, patchOwned } from '../lib/crud';
import { MILESTONE_STATUSES, PAYEE_TYPES, PAYMENT_METHODS } from '../../shared/constants';
import { milestoneBalance, sumMoney, todayISO, toCents } from '../../shared/calc';
import { checkDirectoryLinks, directoryJoin, directoryLinkFields, directorySelect } from '../lib/directoryLinks';

export async function loadPayments(db: pg.Pool | pg.PoolClient, projectId: string, timeZone: string, includeArchived = false) {
  const [ms, txs, att] = await Promise.all([
    db.query(
      `SELECT m.*, bi.name AS budget_item_name, ct.title AS contract_title, ${directorySelect('m')} FROM payment_milestones m
         LEFT JOIN budget_items bi ON bi.id = m.budget_item_id AND bi.project_id = m.project_id
         LEFT JOIN contracts ct ON ct.id = m.contract_id AND ct.project_id = m.project_id
         ${directoryJoin('m')}
        WHERE m.project_id = $1 AND ($2 OR m.archived_at IS NULL)
        ORDER BY m.due_date NULLS LAST, m.created_at`,
      [projectId, includeArchived],
    ),
    db.query(`SELECT * FROM payment_transactions WHERE project_id = $1 ORDER BY paid_date, created_at`, [projectId]),
    db.query(
      `SELECT entity_type, entity_id, count(*)::int AS n FROM attachments
        WHERE project_id = $1 AND archived_at IS NULL AND entity_type IN ('payment_milestone','payment_transaction')
        GROUP BY entity_type, entity_id`,
      [projectId],
    ),
  ]);
  const attCount = new Map(att.rows.map((a) => [`${a.entity_type}:${a.entity_id}`, a.n as number]));
  const today = todayISO(timeZone);
  const milestones = ms.rows.map((m) => {
    const t = txs.rows
      .filter((x) => x.milestone_id === m.id)
      .map((x) => ({ ...x, attachment_count: attCount.get(`payment_transaction:${x.id}`) ?? 0 }));
    return {
      ...m,
      transactions: t,
      attachment_count: attCount.get(`payment_milestone:${m.id}`) ?? 0,
      balance: milestoneBalance(m, t, today),
    };
  });
  const live = milestones.filter((m) => !m.archived_at);
  const liveTx = live.flatMap((m) => m.transactions.filter((t: any) => !t.archived_at));
  return {
    milestones,
    totals: {
      scheduled: sumMoney(live.filter((m) => m.status !== 'cancelled').map((m) => m.scheduled_amount)),
      paid: sumMoney(liveTx.map((t) => t.amount)),
      pending: sumMoney(live.map((m) => m.balance.pending)),
      overdue: sumMoney(live.filter((m) => m.balance.isOverdue).map((m) => m.balance.pending)),
      overdueCount: live.filter((m) => m.balance.isOverdue).length,
      overpaid: sumMoney(live.map((m) => m.balance.overpaid)),
      overpaidCount: live.filter((m) => m.balance.overpaid > 0).length,
      milestoneCount: live.length,
      transactionCount: liveTx.length,
    },
    today,
  };
}

const milestoneSchema = z.object({
  payee_type: z.enum(PAYEE_TYPES),
  payee_name: zText(200).min(1),
  cost_category: zText(160).default(''),
  budget_item_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional(),
  contract_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional(),
  po_contract_ref: zText(120).default(''),
  invoice_ref: zText(120).default(''),
  description: zText(500).min(1),
  due_date: zDate.optional(),
  scheduled_amount: z.preprocess((v) => (typeof v === 'string' && v !== '' ? Number(v) : v), z.number().finite().positive().max(1_000_000_000)),
  status: z.enum(MILESTONE_STATUSES).default('active'),
  notes: zText(4000).default(''),
  ...directoryLinkFields,
});

const txSchema = z.object({
  amount: z.preprocess((v) => (typeof v === 'string' && v !== '' ? Number(v) : v), z.number().finite().positive().max(1_000_000_000)),
  paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'actual transfer date is required (YYYY-MM-DD)'),
  method: z.enum(PAYMENT_METHODS),
  reference: zText(120).default(''),
  notes: zText(4000).default(''),
  allow_overpayment: z.boolean().optional(),
});

/** A milestone may reference a contract only from the same project, and not an archived one. */
async function assertLinkableContract(c: pg.PoolClient, projectId: string, contractId: string | null | undefined) {
  if (!contractId) return;
  await assertSameProject(c, 'contracts', projectId, contractId, 'Contract');
  const { rows } = await c.query('SELECT archived_at FROM contracts WHERE id = $1', [contractId]);
  if (rows[0]?.archived_at) throw badRequest('That contract is archived. Restore it before linking payments to it.');
}

function isUniqueViolation(e: unknown) {
  return (e as { code?: string })?.code === '23505';
}

async function assertNoDuplicateRef(c: pg.PoolClient, projectId: string, method: string, reference: string, exceptId?: string) {
  if (!reference.trim()) return;
  const { rows } = await c.query(
    `SELECT id FROM payment_transactions
      WHERE project_id = $1 AND method = $2 AND upper(btrim(reference)) = upper(btrim($3)) AND archived_at IS NULL
        AND ($4::uuid IS NULL OR id <> $4)`,
    [projectId, method, reference, exceptId ?? null],
  );
  if (rows.length) throw conflict(`Duplicate payment reference "${reference.trim()}" is already recorded in this project`);
}

async function assertOverpaymentAllowed(c: pg.PoolClient, projectId: string, milestoneId: string, newTotalExtraCents: number, allow?: boolean) {
  const m = await getOwned<Record<string, unknown>>(c, 'payment_milestones', projectId, milestoneId);
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(amount),0) AS paid FROM payment_transactions WHERE milestone_id = $1 AND archived_at IS NULL`, [milestoneId]);
  const paidAfter = toCents(rows[0].paid) + newTotalExtraCents;
  if (paidAfter > toCents(m.scheduled_amount as number) && !allow) {
    throw new HttpError(409, 'This transfer would exceed the scheduled milestone amount (overpayment). Confirm to record it anyway.', { code: 'OVERPAYMENT' });
  }
}

export function paymentRoutes(pool: pg.Pool, timeZone: string) {
  const r = Router({ mergeParams: true });

  r.get('/', async (req, res) => {
    assertCap(req, 'payments.read');
    res.json(await loadPayments(pool, req.project!.id, timeZone, req.query.includeArchived === '1'));
  });

  // ---- milestones
  r.post('/milestones', async (req, res) => {
    assertCap(req, 'payments.write');
    const body = parseBody(milestoneSchema, req);
    const pid = req.project!.id;
    const row = await withTx(pool, async (c) => {
      await assertSameProject(c, 'budget_items', pid, body.budget_item_id, 'Budget item');
      await assertLinkableContract(c, pid, body.contract_id);
      await checkDirectoryLinks(c, pid, body);
      const m = await insertRow(c, 'payment_milestones', { ...body, budget_item_id: body.budget_item_id ?? null, contract_id: body.contract_id ?? null, project_id: pid, created_by: req.user!.id });
      await audit(c, req, { projectId: pid, action: 'create', entityType: 'payment_milestone', entityId: m.id as string, summary: `Scheduled payment "${body.description}" to ${body.payee_name}: QAR ${body.scheduled_amount}`, after: m });
      return m;
    });
    res.status(201).json(row);
  });

  r.patch('/milestones/:id', async (req, res) => {
    assertCap(req, 'payments.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(milestoneSchema.partial(), req);
    const pid = req.project!.id;
    const out = await withTx(pool, async (c) => {
      if (body.budget_item_id) await assertSameProject(c, 'budget_items', pid, body.budget_item_id, 'Budget item');
      const cur = await getOwned<Record<string, unknown>>(c, 'payment_milestones', pid, id);
      if (body.contract_id && cur.contract_id !== body.contract_id) await assertLinkableContract(c, pid, body.contract_id);
      await checkDirectoryLinks(c, pid, body as Record<string, unknown>, cur as never);
      const { before, after } = await patchOwned(c, 'payment_milestones', pid, id, body);
      const d = diff(before, after);
      await audit(c, req, { projectId: pid, action: 'update', entityType: 'payment_milestone', entityId: id, summary: `Edited payment milestone "${after.description}" (${d.changed.join(', ')})`, before: d.before, after: d.after });
      return after;
    });
    res.json(out);
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/milestones/:id/${action}`, async (req, res) => {
      assertCap(req, 'payments.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      const out = await withTx(pool, async (c) => {
        const { after } = await patchOwned(c, 'payment_milestones', pid, id, { archived_at: action === 'archive' ? new Date() : null });
        await audit(c, req, { projectId: pid, action, entityType: 'payment_milestone', entityId: id, summary: `${action === 'archive' ? 'Archived' : 'Restored'} payment milestone "${after.description}"` });
        return after;
      });
      res.json(out);
    });
  }

  // ---- actual transfers
  r.post('/milestones/:id/transactions', async (req, res) => {
    assertCap(req, 'payments.write');
    const milestoneId = uuidParam(req, 'id');
    const body = parseBody(txSchema, req);
    const pid = req.project!.id;
    if (body.paid_date > todayISO(timeZone)) throw badRequest('Actual transfer date cannot be in the future. Schedule a milestone instead.');
    try {
      const row = await withTx(pool, async (c) => {
        const m = await getOwned<Record<string, unknown>>(c, 'payment_milestones', pid, milestoneId, { forUpdate: true });
        if (m.archived_at) throw badRequest('Milestone is archived');
        await assertNoDuplicateRef(c, pid, body.method, body.reference);
        await assertOverpaymentAllowed(c, pid, milestoneId, toCents(body.amount), body.allow_overpayment);
        const { allow_overpayment: _ignored, ...data } = body;
        const t = await insertRow(c, 'payment_transactions', { ...data, project_id: pid, milestone_id: milestoneId, created_by: req.user!.id });
        await audit(c, req, { projectId: pid, action: 'create', entityType: 'payment_transaction', entityId: t.id as string, summary: `Recorded transfer QAR ${body.amount} on ${body.paid_date} for "${m.description}"`, after: t });
        return t;
      });
      res.status(201).json(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Duplicate payment reference is already recorded in this project');
      throw e;
    }
  });

  r.patch('/transactions/:id', async (req, res) => {
    assertCap(req, 'payments.write');
    const id = uuidParam(req, 'id');
    const body = parsePatch(txSchema.partial(), req);
    const pid = req.project!.id;
    if (body.paid_date && body.paid_date > todayISO(timeZone)) throw badRequest('Actual transfer date cannot be in the future.');
    try {
      const out = await withTx(pool, async (c) => {
        const cur = await getOwned<Record<string, unknown>>(c, 'payment_transactions', pid, id, { forUpdate: true });
        await assertNoDuplicateRef(c, pid, body.method ?? (cur.method as string), body.reference ?? (cur.reference as string), id);
        if (body.amount !== undefined && !cur.archived_at) {
          await assertOverpaymentAllowed(c, pid, cur.milestone_id as string, toCents(body.amount) - toCents(cur.amount as number), body.allow_overpayment);
        }
        const { allow_overpayment: _ignored, ...data } = body;
        const { before, after } = await patchOwned(c, 'payment_transactions', pid, id, data);
        const d = diff(before, after);
        await audit(c, req, { projectId: pid, action: 'update', entityType: 'payment_transaction', entityId: id, summary: `Edited payment transfer (${d.changed.join(', ')})`, before: d.before, after: d.after });
        return after;
      });
      res.json(out);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Duplicate payment reference is already recorded in this project');
      throw e;
    }
  });

  for (const action of ['archive', 'restore'] as const) {
    r.post(`/transactions/:id/${action}`, async (req, res) => {
      assertCap(req, 'payments.write');
      const id = uuidParam(req, 'id');
      const pid = req.project!.id;
      try {
        const out = await withTx(pool, async (c) => {
          const cur = await getOwned<Record<string, unknown>>(c, 'payment_transactions', pid, id, { forUpdate: true });
          if (action === 'restore') {
            await assertNoDuplicateRef(c, pid, cur.method as string, cur.reference as string, id);
            await assertOverpaymentAllowed(c, pid, cur.milestone_id as string, toCents(cur.amount as number), req.body?.allow_overpayment === true);
          }
          const { after } = await patchOwned(c, 'payment_transactions', pid, id, { archived_at: action === 'archive' ? new Date() : null });
          await audit(c, req, { projectId: pid, action, entityType: 'payment_transaction', entityId: id, summary: `${action === 'archive' ? 'Archived (voided)' : 'Restored'} transfer QAR ${after.amount} on ${after.paid_date}` });
          return after;
        });
        res.json(out);
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Duplicate payment reference is already recorded in this project');
        throw e;
      }
    });
  }

  return r;
}
