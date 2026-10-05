// Itemized budget totals: finalized items subtotal + miscellaneous (counted once) = grand total, compared
// with the independently confirmed control budget. The same function feeds the budget page and the dashboard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Agent, type Ctx } from './helpers';
import { itemizedBudget, todayISO, toCents } from '../shared/calc';
import { financeOverview } from '../src/lib/dashboard';

describe('itemizedBudget (shared calculation)', () => {
  it('reconciles the reference figures exactly', () => {
    const r = itemizedBudget({ finalizedSubtotal: 572500 + 628586.5, missingCount: 0, miscAllowance: 62858.65, controlBudget: 1000000, controlBudgetConfirmed: true });
    expect(r).toMatchObject({ finalizedSubtotal: 1201086.5, miscAllowance: 62858.65, grandTotal: 1263945.15, difference: 263945.15, aboveControl: 263945.15, notAllocated: 0, complete: true });
  });
  it('below budget: "not allocated" amount; incomplete totals are flagged; unconfirmed budgets give no difference', () => {
    expect(itemizedBudget({ finalizedSubtotal: 800000, missingCount: 0, miscAllowance: 50000, controlBudget: 1000000, controlBudgetConfirmed: true }))
      .toMatchObject({ grandTotal: 850000, aboveControl: 0, notAllocated: 150000, difference: -150000 });
    expect(itemizedBudget({ finalizedSubtotal: 800000, missingCount: 3, miscAllowance: 0, controlBudget: 1000000, controlBudgetConfirmed: true }))
      .toMatchObject({ complete: false, missingCount: 3 });
    expect(itemizedBudget({ finalizedSubtotal: 800000, missingCount: 0, miscAllowance: 0, controlBudget: 1000000, controlBudgetConfirmed: false }))
      .toMatchObject({ controlBudget: null, difference: null, aboveControl: 0, notAllocated: 0 });
    expect(itemizedBudget({ finalizedSubtotal: 10, missingCount: 0, miscAllowance: 1, controlBudget: 0, controlBudgetConfirmed: true }))
      .toMatchObject({ grandTotal: 11, difference: 11, aboveControl: 11 });
  });
  it('uses cent arithmetic', () => {
    expect(itemizedBudget({ finalizedSubtotal: 0.1, missingCount: 0, miscAllowance: 0.2, controlBudget: 0.3, controlBudgetConfirmed: true })).toMatchObject({ grandTotal: 0.3, difference: 0 });
  });
  it('itemized costs above budget are not payments above budget', () => {
    const f = financeOverview({ controlBudget: 1000000, controlBudgetConfirmed: true, paid: 0, pending: 0, overdue: 0, overdueCount: 0,
      itemized: itemizedBudget({ finalizedSubtotal: 1201086.5, missingCount: 0, miscAllowance: 62858.65, controlBudget: 1000000, controlBudgetConfirmed: true }) });
    expect(f).toMatchObject({ remaining: 1000000, over: 0 });
    expect(f.itemized!.aboveControl).toBe(263945.15);
  });
});

describe('budget page and dashboard use the same saved records', () => {
  let ctx: Ctx;
  let P = '';
  let admin: Agent;
  let pm: Agent;
  const q = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;
  beforeAll(async () => {
    ctx = await setup();
    P = `/api/projects/${ctx.projects.p1}`;
    admin = await ctx.agent('admin');
    pm = await ctx.agent('pm');
  });
  afterAll(async () => { await ctx.close(); });

  it('subtotal + miscellaneous = grand total; misc uses its existing basis (eligible finishing, no fixed costs) once', async () => {
    expect((await admin.patch(`${P}/settings`, { control_budget: 1000000, control_budget_confirmed: true, misc_percentage: 10 })).status).toBe(200);
    const b = (await admin.get(`${P}/budget`)).body;
    const kind = new Map(b.categories.map((c: any) => [c.id, c]));
    const active = b.items.filter((i: any) => !i.archived_at && !(kind.get(i.category_id) as any).archived_at);
    // give every active item an amount (isolated test data)
    let n = 0;
    for (const i of active) {
      n++;
      const amount = (kind.get(i.category_id) as any).kind === 'fixed' ? 100000 + n : 25000.5 + n;
      expect((await admin.patch(`${P}/budget/items/${i.id}`, { approved_amount: amount })).status).toBe(200);
    }
    const s = (await admin.get(`${P}/budget`)).body.summary;
    const fixedC = s.byKind.find((k: any) => k.kind === 'fixed').subtotal;
    const finishing = s.byKind.find((k: any) => k.kind === 'finishing');
    expect(toCents(s.itemized.finalizedSubtotal)).toBe(s.byKind.reduce((a: number, k: any) => a + toCents(k.subtotal), 0));
    expect(s.itemized.complete).toBe(true);
    // misc is a percentage of eligible finishing items only — fixed costs excluded
    const eligible = b.categories.filter((c: any) => !c.archived_at && c.kind === 'finishing' && c.include_in_misc_basis).map((c: any) => c.id);
    const basisC = active.filter((i: any) => eligible.includes(i.category_id)).length ? toCents(s.misc.basisAmount) : 0;
    expect(toCents(s.misc.allowance)).toBe(Math.round(basisC / 10));
    expect(toCents(s.misc.basisAmount)).toBeLessThanOrEqual(toCents(finishing.subtotal));
    expect(fixedC).toBeGreaterThan(0);
    expect(toCents(s.itemized.grandTotal)).toBe(toCents(s.itemized.finalizedSubtotal) + toCents(s.misc.allowance));
    expect(s.itemized.aboveControl).toBe(Math.max(0, (toCents(s.itemized.grandTotal) - toCents(1000000)) / 100));
    // dashboard shows the same numbers
    const d = (await admin.get(`${P}/dashboard`)).body;
    expect(d.finance.itemized).toEqual(s.itemized);
  });

  it('archived items and missing amounts: archived items leave the total; a blank amount marks it incomplete', async () => {
    const b = (await admin.get(`${P}/budget`)).body;
    const before = b.summary.itemized;
    const target = b.items.find((i: any) => !i.archived_at && i.approved_amount !== null);
    expect((await admin.post(`${P}/budget/items/${target.id}/archive`)).status).toBe(200);
    const after = (await admin.get(`${P}/budget`)).body.summary.itemized;
    expect(toCents(after.finalizedSubtotal)).toBe(toCents(before.finalizedSubtotal) - toCents(target.approved_amount));
    await admin.post(`${P}/budget/items/${target.id}/restore`);
    const blank = b.items.find((i: any) => !i.archived_at && i.id !== target.id);
    await admin.patch(`${P}/budget/items/${blank.id}`, { approved_amount: null });
    const inc = (await admin.get(`${P}/budget`)).body.summary.itemized;
    expect(inc).toMatchObject({ complete: false, missingCount: 1 });
  });

  it('changing item amounts or the misc percentage never changes the saved control budget', async () => {
    const b = (await admin.get(`${P}/budget`)).body;
    const item = b.items.find((i: any) => !i.archived_at && i.approved_amount !== null);
    await admin.patch(`${P}/budget/items/${item.id}`, { approved_amount: 999999 });
    await admin.patch(`${P}/settings`, { misc_percentage: 12.5 });
    const row = (await q('SELECT control_budget, control_budget_confirmed, misc_percentage FROM projects WHERE id = $1', [ctx.projects.p1]))[0];
    expect(row).toEqual({ control_budget: 1000000, control_budget_confirmed: true, misc_percentage: 12.5 });
    const s = (await admin.get(`${P}/budget`)).body.summary;
    expect(s.itemized.controlBudget).toBe(1000000);
    expect(s.misc.percentage).toBe(12.5);
  });

  it('payments (including partial) do not change itemized totals; remaining after payments = budget − paid', async () => {
    const before = (await admin.get(`${P}/dashboard`)).body.finance.itemized;
    const m = (await pm.post(`${P}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Builder', description: 'Stage', scheduled_amount: 100000 })).body;
    await pm.post(`${P}/payments/milestones/${m.id}/transactions`, { amount: 40000, paid_date: todayISO(ctx.cfg.timeZone), method: 'bank_transfer', reference: 'BT-1' });
    const d = (await admin.get(`${P}/dashboard`)).body;
    expect(d.finance.itemized).toEqual(before);
    const f = financeOverview(d.finance);
    expect(f).toMatchObject({ paid: 40000, unpaid: 60000, remaining: 960000 });
  });

  it('roles and isolation: viewers see the totals; contractors get no finance; another project has its own totals', async () => {
    expect((await (await ctx.agent('viewer')).get(`${P}/budget`)).body.summary.itemized.controlBudget).toBe(1000000);
    expect((await (await ctx.agent('contractor')).get(`${P}/budget`)).status).toBe(403);
    expect((await (await ctx.agent('contractor')).get(`${P}/dashboard`)).body.finance).toBeNull();
    const p2 = (await admin.get(`/api/projects/${ctx.projects.p2}/budget`)).body.summary.itemized;
    expect(p2.controlBudget).toBeNull();
    expect(p2.finalizedSubtotal).toBe(0);
    expect((await (await ctx.agent('pm2')).get(`${P}/budget`)).status).toBe(404);
  });
});
