import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Ctx, type Agent } from './helpers';

let ctx: Ctx;
let P: string;
let pm: Agent;
beforeAll(async () => { ctx = await setup(); P = `/api/projects/${ctx.projects.p1}`; pm = await ctx.agent('pm'); });
afterAll(async () => { await ctx.close(); });

describe('payment register', () => {
  it('starts with QAR 0 paid and no commitments', async () => {
    const r = await pm.get(P + '/payments');
    expect(r.body.milestones).toEqual([]);
    expect(r.body.totals).toMatchObject({ scheduled: 0, paid: 0, pending: 0, overdue: 0 });
  });

  let milestoneId = '';
  it('tracks one milestone with multiple transfers and computes pending from transfers', async () => {
    const budget = (await pm.get(P + '/budget')).body;
    const contractorItem = budget.items.find((i: { name: string }) => i.name === 'Contractor Cost');
    const m = await pm.post(P + '/payments/milestones', {
      payee_type: 'contractor', payee_name: 'Main contractor', cost_category: 'Contractor Cost', budget_item_id: contractorItem.id,
      po_contract_ref: 'CT-1', description: 'Advance payment', due_date: '2099-01-31', scheduled_amount: 50000,
    });
    expect(m.status).toBe(201);
    milestoneId = m.body.id;
    // budget edit never creates payments
    let r = await pm.get(P + '/payments');
    expect(r.body.totals).toMatchObject({ scheduled: 50000, paid: 0, pending: 50000 });

    expect((await pm.post(`${P}/payments/milestones/${milestoneId}/transactions`, { amount: 20000, paid_date: '2026-09-01', method: 'bank_transfer', reference: 'TRX-001' })).status).toBe(201);
    expect((await pm.post(`${P}/payments/milestones/${milestoneId}/transactions`, { amount: 10000.55, paid_date: '2026-09-15', method: 'cheque', reference: 'CHQ-77' })).status).toBe(201);
    r = await pm.get(P + '/payments');
    const ms = r.body.milestones[0];
    expect(ms.transactions).toHaveLength(2);
    expect(ms.balance).toMatchObject({ paid: 30000.55, pending: 19999.45, derivedStatus: 'Partially paid' });
    expect(r.body.totals).toMatchObject({ paid: 30000.55, pending: 19999.45 });
    const b = (await pm.get(P + '/budget')).body;
    expect(b.items.find((i: { id: string }) => i.id === contractorItem.id)).toMatchObject({ paid_amount: 30000.55, approved_amount: null });
  });

  it('requires an actual date, rejects future dates and zero/negative amounts', async () => {
    const url = `${P}/payments/milestones/${milestoneId}/transactions`;
    expect((await pm.post(url, { amount: 10, method: 'cash' })).status).toBe(400);
    expect((await pm.post(url, { amount: 10, method: 'cash', paid_date: '2099-01-01' })).status).toBe(400);
    expect((await pm.post(url, { amount: 0, method: 'cash', paid_date: '2026-01-01' })).status).toBe(400);
    expect((await pm.post(url, { amount: -5, method: 'cash', paid_date: '2026-01-01' })).status).toBe(400);
  });

  it('blocks duplicate bank/cheque references (case/space-insensitive)', async () => {
    const url = `${P}/payments/milestones/${milestoneId}/transactions`;
    const dup = await pm.post(url, { amount: 1, paid_date: '2026-09-20', method: 'bank_transfer', reference: ' trx-001 ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/Duplicate/);
  });

  it('requires explicit confirmation to record an overpayment and flags it', async () => {
    const url = `${P}/payments/milestones/${milestoneId}/transactions`;
    const over = await pm.post(url, { amount: 25000, paid_date: '2026-09-25', method: 'bank_transfer', reference: 'TRX-002' });
    expect(over.status).toBe(409);
    expect(over.body.details.code).toBe('OVERPAYMENT');
    expect((await pm.post(url, { amount: 25000, paid_date: '2026-09-25', method: 'bank_transfer', reference: 'TRX-002', allow_overpayment: true })).status).toBe(201);
    const r = await pm.get(P + '/payments');
    expect(r.body.milestones[0].balance).toMatchObject({ paid: 55000.55, pending: 0, overpaid: 5000.55, derivedStatus: 'Overpaid' });
    expect(r.body.totals.overpaidCount).toBe(1);
  });

  it('archiving (voiding) a transfer removes it from the paid total; restore re-checks duplicates', async () => {
    const r = await pm.get(P + '/payments');
    const t = r.body.milestones[0].transactions.find((x: { reference: string }) => x.reference === 'TRX-002');
    expect((await pm.post(`${P}/payments/transactions/${t.id}/archive`)).status).toBe(200);
    const r2 = await pm.get(P + '/payments');
    expect(r2.body.milestones[0].balance.paid).toBe(30000.55);
    // same reference can now be re-used, which then blocks restoring the voided one
    expect((await pm.post(`${P}/payments/milestones/${milestoneId}/transactions`, { amount: 100, paid_date: '2026-09-26', method: 'bank_transfer', reference: 'TRX-002' })).status).toBe(201);
    expect((await pm.post(`${P}/payments/transactions/${t.id}/restore`)).status).toBe(409);
  });

  it('flags overdue unpaid balances and lists upcoming payments', async () => {
    const m = await pm.post(P + '/payments/milestones', { payee_type: 'kahramaa', payee_name: 'Kahramaa', description: 'Connection fee', due_date: '2026-01-15', scheduled_amount: 35000 });
    expect(m.status).toBe(201);
    const r = await pm.get(P + '/payments');
    const k = r.body.milestones.find((x: { id: string }) => x.id === m.body.id);
    expect(k.balance).toMatchObject({ isOverdue: true, derivedStatus: 'Overdue', pending: 35000 });
    expect(r.body.totals.overdue).toBe(35000);
    const d = await pm.get(P + '/dashboard');
    expect(d.body.finance.overduePayments.map((x: { id: string }) => x.id)).toContain(m.body.id);
    // put on hold → no longer overdue
    await pm.patch(`${P}/payments/milestones/${m.body.id}`, { status: 'on_hold' });
    const r2 = await pm.get(P + '/payments');
    expect(r2.body.totals.overdue).toBe(0);
  });

  it('records payment changes in the audit log', async () => {
    const a = await pm.get(P + '/audit');
    const actions = a.body.filter((x: { entity_type: string }) => x.entity_type.startsWith('payment')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'archive', 'update']));
  });

  it('CSV export neutralises spreadsheet formulas', async () => {
    await pm.post(P + '/payments/milestones', { payee_type: 'other', payee_name: '=HYPERLINK("x")', description: 'test', scheduled_amount: 1 });
    const csv = await pm.get(P + '/reports/payments.csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`'=HYPERLINK`);
  });
});
