// Contract finance: paid against the contract, remaining contract balance and scheduled unpaid are
// distinct; only explicitly linked milestones count; nothing is double counted, created or changed.
// Isolated test fixtures only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Agent, type Ctx } from './helpers';
import { contractFinance } from '../shared/contractFinance';

const ms = (over: Partial<{ archived_at: string | null; status: string; scheduled_amount: number; paid: number; pending: number; isOverdue: boolean; tx: number }>) => ({
  archived_at: over.archived_at ?? null, status: over.status ?? 'active', scheduled_amount: over.scheduled_amount ?? 0,
  balance: { paid: over.paid ?? 0, pending: over.pending ?? 0, isOverdue: over.isOverdue ?? false },
  transactions: Array.from({ length: over.tx ?? 0 }, () => ({ archived_at: null })),
});

describe('contractFinance (pure)', () => {
  it('the reported example: 180,000 value, 40,000 advance fully paid', () => {
    expect(contractFinance(180000, [ms({ scheduled_amount: 40000, paid: 40000, pending: 0, tx: 1 })])).toMatchObject({
      contractValue: 180000, paid: 40000, remaining: 140000, scheduledUnpaid: 0, notYetScheduled: 140000, overpaid: 0, transferCount: 1,
    });
  });
  it('missing value is not zero; zero value with payments is overpaid; overpayment is shown', () => {
    expect(contractFinance(null, [ms({ scheduled_amount: 10, paid: 10, tx: 1 })])).toMatchObject({ contractValue: null, remaining: null, notYetScheduled: null, overpaid: 0, paid: 10 });
    expect(contractFinance(0, [ms({ scheduled_amount: 10, paid: 10 })])).toMatchObject({ contractValue: 0, remaining: 0, overpaid: 10 });
    expect(contractFinance(100, [ms({ scheduled_amount: 150, paid: 130, pending: 20 })])).toMatchObject({ remaining: 0, overpaid: 30, scheduledUnpaid: 20, notYetScheduled: 0 });
    expect(contractFinance(1000, [])).toMatchObject({ paid: 0, remaining: 1000, scheduledUnpaid: 0, notYetScheduled: 1000, milestoneCount: 0 });
  });
  it('archived milestones keep their paid amount but leave scheduled unpaid; cancelled milestones are not scheduled', () => {
    const f = contractFinance(500, [
      ms({ scheduled_amount: 100, paid: 60, pending: 40, archived_at: '2026-01-01' }),
      ms({ scheduled_amount: 100, paid: 0, pending: 0, status: 'cancelled' }),
      ms({ scheduled_amount: 200, paid: 50, pending: 150 }),
    ]);
    expect(f).toMatchObject({ paid: 110, paidOnArchived: 60, archivedMilestonesWithPayments: 1, scheduledUnpaid: 150, scheduled: 200, remaining: 390, notYetScheduled: 240, milestoneCount: 2, linkedMilestoneCount: 3 });
  });
  it('uses cent arithmetic', () => {
    expect(contractFinance(0.3, [ms({ paid: 0.1 }), ms({ paid: 0.2 })])).toMatchObject({ paid: 0.3, remaining: 0, overpaid: 0 });
  });
});

describe('contract finance through the API (isolated test projects)', () => {
  let ctx: Ctx;
  let P1 = '';
  let P2 = '';
  let pm: Agent;
  let admin: Agent;
  let cat = '';
  const q = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;
  let ref = 0;
  const pay = async (milestoneId: string, amount: number) => {
    const r = await pm.post(`${P1}/payments/milestones/${milestoneId}/transactions`, { amount, paid_date: '2026-09-15', method: 'bank_transfer', reference: `CF-${++ref}` });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const contract = async (title: string, value: number | null, P = P1, c = cat) => {
    const r = await (P === P1 ? pm : admin).post(`${P}/contracts`, { title, category_id: c, company_name: 'Mokkabbir', ...(value === null ? {} : { contract_value: value }) });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const milestone = async (contractId: string | null, scheduled: number, extra: Record<string, unknown> = {}) => {
    const r = await pm.post(`${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Mokkabbir', description: `M ${Math.random()}`, scheduled_amount: scheduled, contract_id: contractId, ...extra });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const detail = async (id: string) => (await pm.get(`${P1}/contracts/${id}`)).body.payments.summary;
  const listed = async (id: string) => (await pm.get(`${P1}/contracts`)).body.contracts.find((k: any) => k.id === id).payments;

  beforeAll(async () => {
    ctx = await setup();
    P1 = `/api/projects/${ctx.projects.p1}`;
    P2 = `/api/projects/${ctx.projects.p2}`;
    pm = await ctx.agent('pm');
    admin = await ctx.agent('admin');
    cat = (await pm.get(`${P1}/categories`)).body.contract[0].id;
  });
  afterAll(async () => { await ctx.close(); });

  it('Phase 2 example: 180,000 contract, 40,000 advance paid → remaining 140,000, scheduled unpaid 0 (list = detail)', async () => {
    const before = { payTotals: (await pm.get(`${P1}/payments`)).body.totals };
    const k = await contract('Phase 2: Finishing – Mokkabbir', 180000);
    const m = await milestone(k, 40000);
    await pay(m, 40000);
    const d = await detail(k);
    expect(d).toMatchObject({ contractValue: 180000, paid: 40000, remaining: 140000, scheduledUnpaid: 0, notYetScheduled: 140000, overpaid: 0, overdueCount: 0 });
    expect(await listed(k)).toEqual(d); // shared calculation
    // nothing is created for the remaining balance, and the Payments page meaning is unchanged
    expect((await q('SELECT count(*)::int n FROM payment_milestones WHERE contract_id = $1', [k]))[0].n).toBe(1);
    const after = (await pm.get(`${P1}/payments`)).body.totals;
    expect(after.pending).toBe(before.payTotals.pending); // +40,000 scheduled, +40,000 paid → unpaid unchanged
    expect(after.paid).toBe(before.payTotals.paid + 40000);
  });

  it('partially paid milestone, multiple milestones / transfers, a voided transfer and a cancelled milestone', async () => {
    const k = await contract('Multi', 300000);
    const m1 = await milestone(k, 50000);
    const m2 = await milestone(k, 80000, { due_date: '2026-01-10' }); // overdue once unpaid
    const m3 = await milestone(k, 20000);
    await pay(m1, 20000); // partial
    await pay(m2, 30000);
    await pay(m2, 10000);
    const voided = await pay(m3, 5000);
    expect((await pm.post(`${P1}/payments/transactions/${voided}/archive`)).status).toBe(200); // voided → not paid
    await pm.patch(`${P1}/payments/milestones/${m3}`, { status: 'cancelled' });
    const d = await detail(k);
    expect(d).toMatchObject({ paid: 60000, transferCount: 3, scheduledUnpaid: 30000 + 40000, scheduled: 130000, remaining: 240000, notYetScheduled: 170000, overdueCount: 1, milestoneCount: 3 });
    // no double counting against the raw transfers
    const raw = await q(`SELECT COALESCE(SUM(t.amount),0)::float s FROM payment_transactions t JOIN payment_milestones m ON m.id = t.milestone_id WHERE m.contract_id = $1 AND t.archived_at IS NULL`, [k]);
    expect(d.paid).toBe(raw[0].s);
  });

  it('no payment schedule yet; missing / zero values; overpayment', async () => {
    const none = await contract('No schedule', 75000);
    expect(await detail(none)).toMatchObject({ paid: 0, remaining: 75000, scheduledUnpaid: 0, milestoneCount: 0, linkedMilestoneCount: 0 });
    const noValue = await contract('No value', null);
    await pay(await milestone(noValue, 1000), 1000);
    expect(await detail(noValue)).toMatchObject({ contractValue: null, paid: 1000, remaining: null, overpaid: 0 });
    const zero = await contract('Zero value', 0);
    await pay(await milestone(zero, 500), 500);
    expect(await detail(zero)).toMatchObject({ contractValue: 0, remaining: 0, overpaid: 500 });
    const over = await contract('Over', 10000);
    await pay(await milestone(over, 12000), 12000);
    expect(await listed(over)).toMatchObject({ paid: 12000, remaining: 0, overpaid: 2000 });
  });

  it('archiving a milestone keeps its valid payment in the contract paid total (Payments page totals unchanged)', async () => {
    const k = await contract('Archived history', 100000);
    const m = await milestone(k, 30000);
    await pay(m, 30000);
    const pTotals = (await pm.get(`${P1}/payments`)).body.totals;
    expect((await pm.post(`${P1}/payments/milestones/${m}/archive`)).status).toBe(200);
    const d = await detail(k);
    expect(d).toMatchObject({ paid: 30000, paidOnArchived: 30000, archivedMilestonesWithPayments: 1, remaining: 70000, scheduledUnpaid: 0, milestoneCount: 0, linkedMilestoneCount: 1 });
    expect(await listed(k)).toMatchObject({ paid: 30000, remaining: 70000 });
    // the Payments page keeps its existing rule (archived milestones leave its totals)
    expect((await pm.get(`${P1}/payments`)).body.totals.paid).toBe(pTotals.paid - 30000);
  });

  it('only explicitly linked milestones count — not same payee, budget item or another project', async () => {
    const k = await contract('Explicit only', 50000);
    const budgetItem = (await pm.get(`${P1}/budget`)).body.items[0].id;
    await pm.patch(`${P1}/contracts/${k}`, { budget_item_id: budgetItem });
    await pay(await milestone(null, 9000, { budget_item_id: budgetItem }), 9000); // same payee + budget item, not linked
    const other = await contract('Other contract', 50000);
    await pay(await milestone(other, 7000), 7000);
    expect(await detail(k)).toMatchObject({ paid: 0, remaining: 50000, linkedMilestoneCount: 0 });
    expect(await detail(other)).toMatchObject({ paid: 7000 });
    // another project's contract never sees p1 payments, and p1 cannot read it
    const catP2 = (await admin.get(`${P2}/categories`)).body.contract[0].id;
    const k2 = await contract('P2 contract', 20000, P2, catP2);
    expect((await admin.get(`${P2}/contracts/${k2}`)).body.payments.summary).toMatchObject({ paid: 0, remaining: 20000 });
    expect((await pm.get(`${P1}/contracts/${k2}`)).status).toBe(404);
    expect((await pm.post(`${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'X', description: 'x', scheduled_amount: 1, contract_id: k2 })).status).toBe(400);
  });

  it('amendments do not change the contract value or finance; contract finance never changes budgets or payments', async () => {
    const k = await contract('Amended', 180000);
    await pay(await milestone(k, 40000), 40000);
    const snap = async () => ({
      budget: await q('SELECT id, approved_amount FROM budget_items ORDER BY id'),
      project: await q('SELECT control_budget, control_budget_confirmed FROM projects ORDER BY id'),
      ms: await q('SELECT id, scheduled_amount, due_date, status, archived_at FROM payment_milestones ORDER BY id'),
      tx: await q('SELECT id, amount, archived_at FROM payment_transactions ORDER BY id'),
    });
    const before = await snap();
    expect((await pm.post(`${P1}/contracts/${k}/amendments`, { amendment_date: '2026-09-20', description: 'Variation: extra gypsum work (QAR 20,000)' })).status).toBe(201);
    await pm.get(`${P1}/contracts`);
    const d = await detail(k);
    expect(d).toMatchObject({ contractValue: 180000, paid: 40000, remaining: 140000 });
    expect(await snap()).toEqual(before);
    const dash = (await admin.get(`${P1}/dashboard`)).body.finance;
    expect(dash.itemized.grandTotal).toBeDefined();
    expect(JSON.stringify(dash)).not.toContain('140000');
  });

  it('roles: viewers see finance; contractors and consultants cannot open the register', async () => {
    const k = await contract('Roles', 1000);
    expect((await (await ctx.agent('viewer')).get(`${P1}/contracts/${k}`)).body.payments.summary).toMatchObject({ remaining: 1000 });
    expect((await (await ctx.agent('contractor')).get(`${P1}/contracts`)).status).toBe(403);
    expect((await (await ctx.agent('consultant')).get(`${P1}/contracts/${k}`)).status).toBe(403);
  });
});
