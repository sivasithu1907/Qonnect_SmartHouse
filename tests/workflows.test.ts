import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Ctx, type Agent } from './helpers';

let ctx: Ctx;
let admin: Agent;
let P: string;
beforeAll(async () => { ctx = await setup(); admin = await ctx.agent('admin'); P = `/api/projects/${ctx.projects.p1}`; });
afterAll(async () => { await ctx.close(); });

describe('projects', () => {
  let newId = '';
  it('creates a project from the template with structure only', async () => {
    const r = await admin.post('/api/projects', { code: 'PIN 70159999', name: 'Test Villa', location: 'Al Wakra', drive_folder_url: 'https://drive.google.com/drive/folders/abc' });
    expect(r.status).toBe(201);
    newId = r.body.id;
    expect(r.body.misc_percentage).toBe(10);
    const b = await admin.get(`/api/projects/${newId}/budget`);
    expect(b.body.items.length).toBe(19);
    expect(b.body.items.every((i: Record<string, unknown>) => i.approved_amount === null)).toBe(true);
    const t = await admin.get(`/api/projects/${newId}/timeline`);
    expect(t.body.phases).toHaveLength(20);
  });

  it('enforces unique project codes (normalised)', async () => {
    expect((await admin.post('/api/projects', { code: 'pin  70153699', name: 'Dup' })).status).toBe(409);
    expect((await admin.patch(`/api/projects/${newId}`, { code: 'PIN 70153016' })).status).toBe(409);
  });

  it('validates links as http(s) URLs', async () => {
    expect((await admin.patch(`/api/projects/${newId}/links`, { drive_folder_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await admin.patch(`/api/projects/${newId}/links`, { payments_drive_url: 'https://drive.google.com/drive/folders/pay' })).body.payments_drive_url).toContain('pay');
  });

  it('edits, archives and restores with audit history', async () => {
    expect((await admin.patch(`/api/projects/${newId}`, { name: 'Renamed Villa' })).body.name).toBe('Renamed Villa');
    expect((await admin.post(`/api/projects/${newId}/archive`)).body.archived_at).toBeTruthy();
    expect((await admin.get('/api/projects')).body.find((p: { id: string }) => p.id === newId)).toBeUndefined();
    expect((await admin.get('/api/projects?includeArchived=1')).body.find((p: { id: string }) => p.id === newId)).toBeTruthy();
    expect((await admin.post(`/api/projects/${newId}/restore`)).body.archived_at).toBeNull();
    const a = await admin.get(`/api/projects/${newId}/audit`);
    expect(a.body.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['create', 'update', 'archive', 'restore']));
  });

  it('misc percentage is editable per project and only uses approved / finalized amounts', async () => {
    expect((await admin.patch(`${P}/settings`, { misc_basis: 'variant_a_finishing' })).status).toBe(400);
    const r = await admin.patch(`${P}/settings`, { misc_percentage: 12.5 });
    expect(r.status).toBe(200);
    const b = await admin.get(`${P}/budget`);
    expect(b.body.summary.misc).toMatchObject({ basis: 'approved_finishing', percentage: 12.5, basisAmount: 0, allowance: 0, itemsCounted: 0 });
    const floor = b.body.items.find((i: { name: string }) => i.name === 'Floor');
    await admin.patch(`${P}/budget/items/${floor.id}`, { approved_amount: 1000 });
    const b1 = await admin.get(`${P}/budget`);
    expect(b1.body.summary.misc).toMatchObject({ basisAmount: 1000, allowance: 125, itemsCounted: 1 });
    await admin.patch(`${P}/budget/items/${floor.id}`, { approved_amount: null });
    await admin.patch(`${P}/settings`, { misc_percentage: 10 });
    const b2 = await admin.get(`${P}/budget`);
    expect(b2.body.summary.misc).toMatchObject({ basisAmount: 0, allowance: 0, itemsCounted: 0 });
    // other project unaffected
    expect((await admin.get(`/api/projects/${ctx.projects.p2}`)).body.misc_percentage).toBe(10);
  });

  it('control budget must be entered before confirmation; changing it clears confirmation', async () => {
    expect((await admin.patch(`${P}/settings`, { control_budget_confirmed: true })).status).toBe(400);
    const r = await admin.patch(`${P}/settings`, { control_budget: 1200000, control_budget_confirmed: true });
    expect(r.body).toMatchObject({ control_budget: 1200000, control_budget_confirmed: true });
    const r2 = await admin.patch(`${P}/settings`, { control_budget: 1300000 });
    expect(r2.body.control_budget_confirmed).toBe(false);
    await admin.patch(`${P}/settings`, { control_budget: null });
  });
});

describe('budget', () => {
  it('entering an approved / finalized amount is audited and never creates a payment', async () => {
    const b = await admin.get(`${P}/budget`);
    const floor = b.body.items.find((i: { name: string }) => i.name.startsWith('Floor'));
    expect(floor.approved_amount).toBeNull();
    const r = await admin.patch(`${P}/budget/items/${floor.id}`, { approved_amount: 100000 });
    expect(r.body.approved_amount).toBe(100000);
    expect(r.body.approved_by).toBe(ctx.users.admin);
    const pay = await admin.get(`${P}/payments`);
    expect(pay.body.totals.paid).toBe(0);
    expect(pay.body.milestones).toHaveLength(0);
    const a = await admin.get(`${P}/audit`);
    expect(a.body.find((x: { action: string }) => x.action === 'approve')).toBeTruthy();
    const d = await admin.get(`${P}/dashboard`);
    expect(d.body.finance.approvedCommitments).toBe(100000);
    await admin.patch(`${P}/budget/items/${floor.id}`, { approved_amount: null });
  });

  it('budget API, summary and CSV expose no variant / estimate amounts; legacy estimate fields are ignored', async () => {
    const b = await admin.get(`${P}/budget`);
    const text = JSON.stringify(b.body);
    expect(text).not.toMatch(/variant|source_amount|source_status|references/i);
    const k = b.body.items.find((i: { name: string }) => i.name === 'Kahramaa Cost');
    const r = await admin.patch(`${P}/budget/items/${k.id}`, { source_amount: 36000, source_variant_a: 1 });
    expect(r.status).toBe(200);
    expect(r.body.approved_amount).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/variant|source_amount/i);
    const row = (await ctx.pool.query('SELECT source_amount, source_variant_a FROM budget_items WHERE id = $1', [k.id])).rows[0];
    expect(row).toEqual({ source_amount: null, source_variant_a: null });
    const csv = await admin.get(`${P}/reports/budget.csv`);
    expect(csv.text).toContain('Approved / Finalized Amount (QAR)');
    expect(csv.text).not.toMatch(/variant/i);
    const d = await admin.get(`${P}/dashboard`);
    expect(JSON.stringify(d.body)).not.toMatch(/variant|source_amount/i);
  });

  it('PATCH never resets fields that were not sent', async () => {
    const b = await admin.get(`${P}/budget`);
    const it0 = b.body.items.find((i: { name: string }) => i.name.startsWith('Window'));
    const r = await admin.patch(`${P}/budget/items/${it0.id}`, { description: 'Aluminium windows' });
    expect(r.body.notes).toBe(it0.notes);
    expect(r.body.source_label).toBe(it0.source_label);
  });

  it('adds, edits, archives and restores categories and items', async () => {
    const c = await admin.post(`${P}/categories/budget`, { name: 'Swimming pool', kind: 'finishing' });
    expect(c.status).toBe(201);
    const i = await admin.post(`${P}/budget/items`, { category_id: c.body.id, name: 'Pool shell', notes: 'Owner request' });
    expect(i.status).toBe(201);
    expect(i.body.approved_amount).toBeNull();
    expect((await admin.patch(`${P}/categories/budget/${c.body.id}`, { name: 'Pool' })).body.name).toBe('Pool');
    expect((await admin.post(`${P}/budget/items/${i.body.id}/archive`)).body.archived_at).toBeTruthy();
    expect((await admin.post(`${P}/budget/items/${i.body.id}/restore`)).body.archived_at).toBeNull();
    expect((await admin.post(`${P}/categories/budget/${c.body.id}/archive`)).body.archived_at).toBeTruthy();
    // archived categories cannot take new items
    expect((await admin.post(`${P}/budget/items`, { category_id: c.body.id, name: 'Pool pump' })).status).toBe(400);
    // category from another project cannot be used
    const b2 = await admin.get(`/api/projects/${ctx.projects.p2}/budget`);
    expect((await admin.post(`${P}/budget/items`, { category_id: b2.body.categories[0].id, name: 'x' })).status).toBe(400);
  });

  it('cannot archive a budget item linked to active payments', async () => {
    const b = await admin.get(`${P}/budget`);
    const cc = b.body.items.find((i: { name: string }) => i.name === 'Consultant Cost');
    await admin.post(`${P}/payments/milestones`, { payee_type: 'consultant', payee_name: 'X', description: 'Fee 1', scheduled_amount: 1000, budget_item_id: cc.id });
    expect((await admin.post(`${P}/budget/items/${cc.id}/archive`)).status).toBe(400);
  });
});

describe('materials', () => {
  it('creates and edits a line; delivery date changes are audited', async () => {
    const pm = await ctx.agent('pm');
    const cats = (await pm.get(`${P}/categories`)).body.material;
    const wd = cats.find((c: { name: string }) => c.name === 'Windows & Doors');
    expect((await pm.post(`${P}/materials`, { category: 'Windows & Doors', description: 'Free text is no longer accepted' })).status).toBe(400);
    const r = await pm.post(`${P}/materials`, { category_id: wd.id, description: 'Front door hardware' });
    expect(r.body.category).toBe('Windows & Doors');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'Status not confirmed', supply_responsibility: 'needs_confirmation' });
    const u = await pm.patch(`${P}/materials/${r.body.id}`, { revised_delivery_date: '2026-11-20', status: 'Delayed' });
    expect(u.body.revised_delivery_date).toBe('2026-11-20');
    expect(u.body.description).toBe('Front door hardware');
    const a = await pm.get(`${P}/audit`);
    expect(a.body.find((x: { action: string; entity_id: string }) => x.action === 'delivery_date_change' && x.entity_id === r.body.id)).toBeTruthy();
    expect((await pm.patch(`${P}/materials/${r.body.id}`, { status: 'Made up' })).status).toBe(400);
    expect((await pm.patch(`${P}/materials/${r.body.id}`, { planned_delivery_date: '10/10/2026' })).status).toBe(400);
    expect((await pm.post(`${P}/materials/${r.body.id}/archive`)).status).toBe(200);
    const list = await pm.get(`${P}/materials`);
    expect(list.body.items.find((m: { id: string }) => m.id === r.body.id)).toBeUndefined();
    expect((await pm.post(`${P}/materials/${r.body.id}/restore`)).status).toBe(200);
  });

  it('dashboard counts materials awaiting confirmation and due soon without inventing data', async () => {
    const d = await admin.get(`${P}/dashboard`);
    expect(d.body.materials.awaitingConfirmation).toBeGreaterThanOrEqual(40);
    expect(d.body.materials.partiallyDelivered).toBe(0);
  });
});

describe('timeline', () => {
  it('completion requires an actual date and completed predecessors (unless overridden)', async () => {
    const t = await admin.get(`${P}/timeline`);
    const plaster = t.body.tasks.find((x: { template_key: string }) => x.template_key === 'p10-plaster');
    expect((await admin.patch(`${P}/timeline/tasks/${plaster.id}`, { status: 'Completed' })).status).toBe(400);
    const blocked = await admin.patch(`${P}/timeline/tasks/${plaster.id}`, { status: 'Completed', actual_end: '2026-09-29' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.code).toBe('DEPENDENCIES_OPEN');
    const forced = await admin.patch(`${P}/timeline/tasks/${plaster.id}`, { status: 'Completed', actual_end: '2026-09-29', override_dependencies: true });
    expect(forced.status).toBe(200);
    const a = await admin.get(`${P}/audit`);
    expect(a.body.find((x: { summary: string }) => x.summary.includes('dependency check overridden'))).toBeTruthy();
  });

  it('rejects circular dependencies and cross-project dependencies', async () => {
    const t = await admin.get(`${P}/timeline`);
    const insp = t.body.tasks.find((x: { template_key: string }) => x.template_key === 'p09-insp');
    const plaster = t.body.tasks.find((x: { template_key: string }) => x.template_key === 'p10-plaster');
    expect((await admin.patch(`${P}/timeline/tasks/${insp.id}`, { depends_on: [plaster.id] })).status).toBe(400);
    const t2 = await admin.get(`/api/projects/${ctx.projects.p2}/timeline`);
    expect((await admin.patch(`${P}/timeline/tasks/${insp.id}`, { depends_on: [t2.body.tasks[0].id] })).status).toBe(400);
  });

  it('adds tasks and phases, approves a phase schedule', async () => {
    const t = await admin.get(`${P}/timeline`);
    const ph = t.body.phases[0];
    const n = await admin.post(`${P}/timeline/tasks`, { phase_id: ph.id, name: 'Kick-off meeting', planned_start: '2026-10-01' });
    expect(n.status).toBe(201);
    const p = await admin.patch(`${P}/timeline/phases/${ph.id}`, { planned_start: '2026-10-01', planned_end: '2026-10-15', schedule_approved: true });
    expect(p.body.schedule_approved).toBe(true);
    expect((await admin.post(`${P}/timeline/phases`, { name: 'Extra phase' })).body.seq).toBe(21);
  });
});

describe('visits', () => {
  it('registers start empty and support follow-up actions', async () => {
    const pm = await ctx.agent('pm');
    expect((await pm.get(`${P}/visits/consultant`)).body).toEqual([]);
    expect((await pm.get(`${P}/visits/site`)).body).toEqual([]);
    const v = await pm.post(`${P}/visits/consultant`, { purpose: 'MEP first-fix inspection', consultant_user_id: ctx.users.consultant, planned_at: '2026-10-10T06:00:00.000Z' });
    expect(v.status).toBe(201);
    const act = await pm.post(`${P}/visits/consultant/${v.body.id}/actions`, { description: 'Fix conduit spacing', due_date: '2026-10-12' });
    expect(act.status).toBe(201);
    expect((await pm.patch(`${P}/visits/actions/${act.body.id}`, { status: 'Closed' })).body.status).toBe('Closed');
    const list = await pm.get(`${P}/visits/consultant`);
    expect(list.body[0].actions).toHaveLength(1);
    // assigning a non-consultant as consultant is rejected
    expect((await pm.post(`${P}/visits/consultant`, { purpose: 'x', consultant_user_id: ctx.users.viewer })).status).toBe(400);
  });
});
