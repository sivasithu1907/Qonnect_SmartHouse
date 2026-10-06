// Contracts & Documents: project isolation, role permissions, secure contract files,
// amendments, payment-milestone links, audit, archived projects — and that nothing here
// changes budget amounts, creates payment milestones or marks anything paid.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF, setup, type Agent, type Ctx } from './helpers';
import { redactContract } from '../server/routes/contracts';
import { DEFAULT_CONTRACT_CATEGORIES } from '../shared/constants';

let ctx: Ctx;
let P1 = '';
let P2 = '';
let admin: Agent;
let pm: Agent;
let pm2: Agent;
let viewer: Agent;
let contractor: Agent;
let consultant: Agent;
let outsider: Agent;
let cat1 = '';     // Main Contractor in p1
let catP2 = '';    // Main Contractor in p2
let budgetItem1 = '';
let budgetItemP2 = '';
let contractId = '';
let contractP2 = '';

const snapshot = async () => {
  const b = await ctx.pool.query('SELECT id, approved_amount FROM budget_items ORDER BY id');
  const m = await ctx.pool.query('SELECT count(*)::int n FROM payment_milestones');
  const t = await ctx.pool.query('SELECT count(*)::int n FROM payment_transactions');
  return { budget: b.rows, milestones: m.rows[0].n, transfers: t.rows[0].n };
};

beforeAll(async () => {
  ctx = await setup();
  P1 = `/api/projects/${ctx.projects.p1}`;
  P2 = `/api/projects/${ctx.projects.p2}`;
  [admin, pm, pm2, viewer, contractor, consultant, outsider] = await Promise.all(
    ['admin', 'pm', 'pm2', 'viewer', 'contractor', 'consultant', 'outsider'].map((k) => ctx.agent(k)),
  );
  cat1 = (await pm.get(P1 + '/categories')).body.contract[0].id;
  catP2 = (await admin.get(P2 + '/categories')).body.contract[0].id;
  budgetItem1 = (await pm.get(P1 + '/budget')).body.items[0].id;
  budgetItemP2 = (await admin.get(P2 + '/budget')).body.items[0].id;
});
afterAll(async () => { await ctx.close(); });

describe('starting state', () => {
  it('every project starts with the four default categories and no contracts', async () => {
    for (const [agent, P] of [[pm, P1], [admin, P2]] as const) {
      const cats = (await agent.get(P + '/categories')).body.contract;
      expect(cats.map((c: { name: string }) => c.name)).toEqual([...DEFAULT_CONTRACT_CATEGORIES]);
      const list = await agent.get(P + '/contracts');
      expect(list.status).toBe(200);
      expect(list.body.contracts).toEqual([]);
    }
    expect((await ctx.pool.query('SELECT count(*)::int n FROM contracts')).rows[0].n).toBe(0);
  });

  it('a newly created project gets the default categories too', async () => {
    const r = await admin.post('/api/projects', { code: 'PIN TEST-1', name: 'Test villa', template: { budget: false, timeline: false } });
    expect(r.status).toBe(201);
    const cats = (await admin.get(`/api/projects/${r.body.id}/categories`)).body.contract;
    expect(cats.map((c: { name: string }) => c.name)).toEqual([...DEFAULT_CONTRACT_CATEGORIES]);
  });
});

describe('contract register', () => {
  it('a project manager adds a contract; it is audited and changes no budget or payment data', async () => {
    const before = await snapshot();
    const r = await pm.post(P1 + '/contracts', {
      title: 'Main construction agreement', category_id: cat1, company_name: 'Builder Co', reference: 'MC-01',
      signed_date: '2026-09-01', contract_value: 509500, status: 'Signed', drive_url: 'https://drive.google.com/x', budget_item_id: budgetItem1,
    });
    expect(r.status).toBe(201);
    contractId = r.body.id;
    expect(await snapshot()).toEqual(before);
    const a = await ctx.pool.query(`SELECT action, summary FROM audit_log WHERE entity_type = 'contract' AND entity_id = $1`, [contractId]);
    expect(a.rows).toEqual([{ action: 'create', summary: 'Added contract "Main construction agreement" with Builder Co' }]);

    const list = (await pm.get(P1 + '/contracts')).body;
    expect(list.contracts).toHaveLength(1);
    expect(list.contracts[0]).toMatchObject({ title: 'Main construction agreement', category_name: 'Main Contractor', contract_value: 509500, status: 'Signed', attachment_count: 0, amendment_count: 0 });
    expect(list.contracts[0].payments).toMatchObject({ milestoneCount: 0, scheduled: 0, paid: 0, scheduledUnpaid: 0, overdueCount: 0, linkedMilestoneCount: 0 });
  });

  it('validates fields and rejects categories or budget items from another project', async () => {
    const ok = { title: 'X', category_id: cat1, company_name: 'Y' };
    expect((await pm.post(P1 + '/contracts', { ...ok, category_id: catP2 })).status).toBe(400);
    expect((await pm.post(P1 + '/contracts', { ...ok, budget_item_id: budgetItemP2 })).status).toBe(400);
    expect((await pm.post(P1 + '/contracts', { ...ok, status: 'Pending' })).status).toBe(400);
    expect((await pm.post(P1 + '/contracts', { ...ok, drive_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await pm.post(P1 + '/contracts', { ...ok, contract_value: -5 })).status).toBe(400);
    expect((await pm.post(P1 + '/contracts', { category_id: cat1, company_name: 'Y' })).status).toBe(400);
    expect((await pm.patch(`${P1}/contracts/${contractId}`, { budget_item_id: budgetItemP2 })).status).toBe(400);
  });

  it('edits are audited with before/after; archive hides it unless archived are requested; restore brings it back', async () => {
    const before = await snapshot();
    const e = await pm.patch(`${P1}/contracts/${contractId}`, { status: 'Active', contract_value: 510000 });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ status: 'Active', contract_value: 510000, title: 'Main construction agreement' });
    expect(await snapshot()).toEqual(before); // value change never touches budget / payments
    const a = await ctx.pool.query(`SELECT before, after FROM audit_log WHERE entity_type = 'contract' AND action = 'update' AND entity_id = $1`, [contractId]);
    expect(a.rows[0].before).toMatchObject({ status: 'Signed', contract_value: 509500 });
    expect(a.rows[0].after).toMatchObject({ status: 'Active', contract_value: 510000 });

    expect((await pm.post(`${P1}/contracts/${contractId}/archive`)).status).toBe(200);
    expect((await pm.get(P1 + '/contracts')).body.contracts).toHaveLength(0);
    expect((await pm.get(P1 + '/contracts?includeArchived=1')).body.contracts).toHaveLength(1);
    expect((await pm.post(`${P1}/contracts/${contractId}/restore`)).status).toBe(200);
    expect((await pm.get(P1 + '/contracts')).body.contracts).toHaveLength(1);
  });
});

describe('project isolation and permissions', () => {
  beforeAll(async () => {
    contractP2 = (await admin.post(P2 + '/contracts', { title: 'P2 consultant agreement', category_id: catP2, company_name: 'Consult LLC' })).body.id;
  });

  it('records never leak to another project', async () => {
    expect((await pm.get(`${P1}/contracts/${contractP2}`)).status).toBe(404);              // p2 record via p1 path
    expect((await admin.get(`${P2}/contracts/${contractId}`)).status).toBe(404);           // p1 record via p2 path
    expect((await admin.patch(`${P2}/contracts/${contractId}`, { title: 'hijack' })).status).toBe(404);
    expect((await admin.post(`${P2}/contracts/${contractId}/archive`)).status).toBe(404);
    expect((await pm2.get(P1 + '/contracts')).status).toBe(404);                           // not a member of p1
    expect((await pm2.get(`${P1}/contracts/${contractId}`)).status).toBe(404);
    expect((await outsider.get(P1 + '/contracts')).status).toBe(404);
    expect((await pm.get(P1 + '/contracts')).body.contracts.map((k: { id: string }) => k.id)).toEqual([contractId]);
    expect((await admin.post(`${P2}/contracts/${contractId}/amendments`, { amendment_date: '2026-09-10', description: 'x' })).status).toBe(404);
  });

  it('viewers can read but not change; contractors and consultants cannot see the register', async () => {
    const v = await viewer.get(`${P1}/contracts/${contractId}`);
    expect(v.status).toBe(200);
    expect(v.body.contract_value).toBe(510000); // viewers have financial read access (payments.read)
    expect((await viewer.post(P1 + '/contracts', { title: 'x', category_id: cat1, company_name: 'y' })).status).toBe(403);
    expect((await viewer.patch(`${P1}/contracts/${contractId}`, { title: 'x' })).status).toBe(403);
    expect((await viewer.post(`${P1}/contracts/${contractId}/archive`)).status).toBe(403);
    for (const a of [contractor, consultant]) {
      expect((await a.get(P1 + '/contracts')).status).toBe(403);
      expect((await a.get(`${P1}/contracts/${contractId}`)).status).toBe(403);
      expect((await a.post(P1 + '/contracts', { title: 'x', category_id: cat1, company_name: 'y' })).status).toBe(403);
      expect((await a.get(P1 + '/categories')).body.contract).toEqual([]);
    }
  });

  it('financial fields are removed (not zeroed) for roles without financial access', () => {
    const row = { id: 'k', title: 'T', contract_value: 100, payments: { paid: 1 }, budget_item_id: 'b', budget_item_name: 'B' };
    expect(redactContract(row, { finance: false, budget: false })).toEqual({ id: 'k', title: 'T' });
    expect(redactContract(row, { finance: true, budget: true })).toEqual(row);
  });

  it('only admins manage contract categories; a category in use cannot be deleted; archived categories are not offered', async () => {
    expect((await pm.post(P1 + '/categories/contract', { name: 'MEP Subcontract' })).status).toBe(403);
    const c = await admin.post(P1 + '/categories/contract', { name: 'MEP Subcontract' });
    expect(c.status).toBe(201);
    expect((await admin.post(P1 + '/categories/contract', { name: 'mep subcontract ' })).status).toBe(409);
    const del = await ctx.agent('admin').then((a) => a.raw.delete(`${P1}/categories/contract/${cat1}`).set('X-CSRF-Token', a.csrf));
    expect(del.status).toBe(409);
    expect((await admin.post(`${P1}/categories/contract/${c.body.id}/archive`)).status).toBe(200);
    expect((await pm.post(P1 + '/contracts', { title: 'x', category_id: c.body.id, company_name: 'y' })).status).toBe(400);
    expect((await ctx.pool.query(`SELECT count(*)::int n FROM audit_log WHERE entity_type = 'contract_category'`)).rows[0].n).toBe(2);
  });
});

describe('contract documents (existing secure upload system)', () => {
  let signedId = '';
  let quoteId = '';
  it('uploads a signed contract and a quotation with uploader and date', async () => {
    const s = await pm.upload(P1 + '/attachments', { entity_type: 'contract', entity_id: contractId, kind: 'signed_contract' }, { buf: PDF, name: 'signed.pdf' });
    expect(s.status).toBe(201);
    signedId = s.body.id;
    const q = await pm.upload(P1 + '/attachments', { entity_type: 'contract', entity_id: contractId, kind: 'quotation' }, { buf: PDF, name: 'quote.pdf' });
    expect(q.status).toBe(201);
    quoteId = q.body.id;
    expect((await pm.upload(P1 + '/attachments', { entity_type: 'contract', entity_id: contractId, kind: 'boq' }, { buf: PDF, name: 'boq.pdf' })).status).toBe(201);
    const list = await viewer.get(`${P1}/attachments?entity_type=contract&entity_id=${contractId}`);
    expect(list.status).toBe(200);
    expect(list.body.map((a: { kind: string }) => a.kind).sort()).toEqual(['boq', 'quotation', 'signed_contract']);
    expect(list.body[0]).toMatchObject({ uploaded_by_name: 'pm' });
    expect(list.body[0].created_at).toBeTruthy();
    expect((await pm.get(P1 + '/contracts')).body.contracts[0].attachment_count).toBe(3);
    const audits = await ctx.pool.query(`SELECT summary FROM audit_log WHERE action = 'upload' AND entity_type = 'contract' AND entity_id = $1`, [contractId]);
    expect(audits.rows).toHaveLength(3);
  });

  it('preview and download re-check access and project', async () => {
    const inline = await viewer.get(`${P1}/attachments/${signedId}/download?inline=1`);
    expect(inline.status).toBe(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    expect((await pm.get(`${P1}/attachments/${signedId}/download`)).headers['content-disposition']).toMatch(/^attachment;/);
    expect((await contractor.get(`${P1}/attachments/${signedId}/download`)).status).toBe(403);
    expect((await consultant.get(`${P1}/attachments?entity_type=contract&entity_id=${contractId}`)).status).toBe(403);
    expect((await pm2.get(`${P1}/attachments/${signedId}/download`)).status).toBe(404);
    expect((await admin.get(`${P2}/attachments/${signedId}/download`)).status).toBe(404);
    expect((await admin.upload(P2 + '/attachments', { entity_type: 'contract', entity_id: contractId, kind: 'quotation' }, { buf: PDF, name: 'x.pdf' })).status).toBe(404);
  });

  it('only writers upload, and only contract document types go on contracts', async () => {
    expect((await viewer.upload(P1 + '/attachments', { entity_type: 'contract', entity_id: contractId, kind: 'quotation' }, { buf: PDF, name: 'x.pdf' })).status).toBe(403);
    expect((await pm.upload(P1 + '/attachments', { entity_type: 'contract', entity_id: contractId, kind: 'payment_slip' }, { buf: PDF, name: 'x.pdf' })).status).toBe(400);
    const m = await pm.post(P1 + '/payments/milestones', { payee_type: 'contractor', payee_name: 'Builder Co', description: 'Doc type check', scheduled_amount: 10 });
    expect((await pm.upload(P1 + '/attachments', { entity_type: 'payment_milestone', entity_id: m.body.id, kind: 'signed_contract' }, { buf: PDF, name: 'x.pdf' })).status).toBe(400);
    expect((await pm.upload(P1 + '/attachments', { entity_type: 'payment_milestone', entity_id: m.body.id, kind: 'supporting_document' }, { buf: PDF, name: 'x.pdf' })).status).toBe(201);
    await pm.post(`${P1}/payments/milestones/${m.body.id}/archive`);
  });

  it('the original signed agreement is kept: only an admin can archive a signed-contract file', async () => {
    expect((await pm.post(`${P1}/attachments/${signedId}/archive`)).status).toBe(403);
    expect((await pm.post(`${P1}/attachments/${quoteId}/archive`)).status).toBe(200);
    expect((await admin.post(`${P1}/attachments/${signedId}/archive`)).status).toBe(200);
    expect((await ctx.pool.query('SELECT count(*)::int n FROM attachments WHERE id = $1', [signedId])).rows[0].n).toBe(1); // soft archive
  });

  it('amendments are separate records with their own files; the contract itself is unchanged', async () => {
    const before = (await pm.get(`${P1}/contracts/${contractId}`)).body;
    expect((await pm.post(`${P1}/contracts/${contractId}/amendments`, { description: 'no date' })).status).toBe(400);
    const a = await pm.post(`${P1}/contracts/${contractId}/amendments`, { amendment_date: '2026-09-20', description: 'Added boundary wall scope', reference: 'VO-1' });
    expect(a.status).toBe(201);
    expect((await viewer.post(`${P1}/contracts/${contractId}/amendments`, { amendment_date: '2026-09-21', description: 'x' })).status).toBe(403);
    expect((await pm.upload(P1 + '/attachments', { entity_type: 'contract_amendment', entity_id: a.body.id, kind: 'amendment' }, { buf: PDF, name: 'vo1.pdf' })).status).toBe(201);
    const after = (await pm.get(`${P1}/contracts/${contractId}`)).body;
    expect(after.amendments).toHaveLength(1);
    expect(after.amendments[0]).toMatchObject({ amendment_date: '2026-09-20', description: 'Added boundary wall scope', reference: 'VO-1', attachment_count: 1 });
    expect(after.amendment_count).toBe(1);
    for (const k of ['title', 'contract_value', 'status', 'signed_date', 'reference', 'updated_at']) expect(after[k]).toEqual(before[k]);
    expect((await pm.patch(`${P1}/contracts/amendments/${a.body.id}`, { description: 'Added boundary wall + gate' })).status).toBe(200);
    expect((await admin.patch(`${P2}/contracts/amendments/${a.body.id}`, { description: 'x' })).status).toBe(404);
    const audits = await ctx.pool.query(`SELECT action FROM audit_log WHERE entity_type = 'contract_amendment' ORDER BY id`);
    expect(audits.rows.map((r) => r.action)).toEqual(['create', 'upload', 'update']);
  });
});

describe('payment milestone links', () => {
  let milestoneId = '';
  it('a milestone may reference a contract from the same project only, and not an archived one', async () => {
    const base = { payee_type: 'contractor', payee_name: 'Builder Co', description: 'Advance payment', scheduled_amount: 50000, due_date: '2099-12-31' };
    expect((await pm.post(P1 + '/payments/milestones', { ...base, contract_id: contractP2 })).status).toBe(400);
    const m = await pm.post(P1 + '/payments/milestones', { ...base, contract_id: contractId });
    expect(m.status).toBe(201);
    milestoneId = m.body.id;
    expect(m.body.contract_id).toBe(contractId);
    expect((await pm.patch(`${P1}/payments/milestones/${milestoneId}`, { contract_id: contractP2 })).status).toBe(400);

    const spare = (await pm.post(P1 + '/contracts', { title: 'Spare', category_id: cat1, company_name: 'Z' })).body.id;
    await pm.post(`${P1}/contracts/${spare}/archive`);
    expect((await pm.post(P1 + '/payments/milestones', { ...base, contract_id: spare })).status).toBe(400);
    const pay = (await pm.get(P1 + '/payments')).body.milestones.find((x: { id: string }) => x.id === milestoneId);
    expect(pay.contract_title).toBe('Main construction agreement');
  });

  it('contract details show paid, remaining contract balance and scheduled unpaid separately', async () => {
    expect((await pm.post(`${P1}/payments/milestones/${milestoneId}/transactions`, { amount: 20000, paid_date: '2026-09-15', method: 'bank_transfer', reference: 'TRF-77' })).status).toBe(201);
    const d = (await pm.get(`${P1}/contracts/${contractId}`)).body;
    expect(d.payments.summary).toMatchObject({ contractValue: 510000, milestoneCount: 1, scheduled: 50000, paid: 20000, remaining: 490000, scheduledUnpaid: 30000, notYetScheduled: 460000, overpaid: 0, overdueCount: 0 });
    expect(d.payments.milestones).toHaveLength(1);
    expect(d.payments.milestones[0]).toMatchObject({ id: milestoneId, description: 'Advance payment', balance: { paid: 20000, pending: 30000, derivedStatus: 'Partially paid' } });
    const list = (await viewer.get(P1 + '/contracts')).body.contracts.find((k: { id: string }) => k.id === contractId);
    expect(list.payments).toMatchObject({ milestoneCount: 1, paid: 20000, remaining: 490000, scheduledUnpaid: 30000 });
    // the contract value is untouched by payments and payments are untouched by the value
    expect(d.contract_value).toBe(510000);
    const ms = await ctx.pool.query('SELECT scheduled_amount FROM payment_milestones WHERE id = $1', [milestoneId]);
    expect(ms.rows[0].scheduled_amount).toBe(50000);
  });

  it('archiving a contract does not change linked payments', async () => {
    const before = (await pm.get(P1 + '/payments')).body.totals;
    await pm.post(`${P1}/contracts/${contractId}/archive`);
    expect((await pm.get(P1 + '/payments')).body.totals).toEqual(before);
    expect((await pm.post(`${P1}/contracts/${contractId}/amendments`, { amendment_date: '2026-09-22', description: 'x' })).status).toBe(400);
    await pm.post(`${P1}/contracts/${contractId}/restore`);
  });
});

describe('archived projects are read-only', () => {
  it('blocks contract, amendment, category and file changes but still allows reading', async () => {
    expect((await admin.post(`${P2}/archive`)).status).toBe(200);
    expect((await admin.post(P2 + '/contracts', { title: 'x', category_id: catP2, company_name: 'y' })).status).toBe(409);
    expect((await admin.patch(`${P2}/contracts/${contractP2}`, { title: 'x' })).status).toBe(409);
    expect((await admin.post(`${P2}/contracts/${contractP2}/amendments`, { amendment_date: '2026-09-22', description: 'x' })).status).toBe(409);
    expect((await admin.post(P2 + '/categories/contract', { name: 'New' })).status).toBe(409);
    expect((await admin.upload(P2 + '/attachments', { entity_type: 'contract', entity_id: contractP2, kind: 'quotation' }, { buf: PDF, name: 'x.pdf' })).status).toBe(409);
    expect((await admin.get(`${P2}/contracts/${contractP2}`)).status).toBe(200);
    expect((await pm2.get(P2 + '/contracts')).status).toBe(404); // hidden from non-admins while archived
  });
});
