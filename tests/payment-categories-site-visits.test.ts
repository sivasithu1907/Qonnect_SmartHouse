// Update 13: payment cost category linked to Master Items & Budget categories, and the site visit workflow.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG, setup, type Agent, type Ctx } from './helpers';

let ctx: Ctx;
let admin: Agent, pm: Agent, pm2: Agent, viewer: Agent, contractor: Agent, contractor2: Agent;
let P1: string, P2: string;
type Cat = { id: string; name: string; kind: string; archived_at: string | null };
type BItem = { id: string; name: string; category_id: string; paid_amount: number; scheduled_amount: number };
let cats: Cat[], items: BItem[];

beforeAll(async () => {
  ctx = await setup();
  [admin, pm, pm2, viewer, contractor, contractor2] = await Promise.all(['admin', 'pm', 'pm2', 'viewer', 'contractor', 'contractor2'].map((r) => ctx.agent(r)));
  P1 = `/api/projects/${ctx.projects.p1}`;
  P2 = `/api/projects/${ctx.projects.p2}`;
  const b = (await pm.get(`${P1}/budget`)).body;
  cats = b.categories; items = b.items;
});
afterAll(async () => { await ctx.close(); });

const q = async (sql: string, args: unknown[] = []) => (await ctx.pool.query(sql, args)).rows;
const ms = (over: Record<string, unknown> = {}) => ({ payee_type: 'supplier', payee_name: 'Supplier A', description: 'Deposit', scheduled_amount: 1000, ...over });
const getM = async (id: string) => (await pm.get(`${P1}/payments`)).body.milestones.find((m: { id: string }) => m.id === id);

describe('payments: cost category from Master Items & Budget', () => {
  it('a category-only payment counts in project totals but is not attributed to any budget item', async () => {
    const tiles = cats.find((c) => c.name === 'Floor') ?? cats.find((c) => c.kind === 'finishing')!;
    const before = (await pm.get(`${P1}/budget`)).body;
    const r = await pm.post(`${P1}/payments/milestones`, ms({ budget_category_id: tiles.id, scheduled_amount: 2500 }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ budget_category_id: tiles.id, budget_item_id: null, cost_category: '' });
    expect((await pm.post(`${P1}/payments/milestones/${r.body.id}/transactions`, { amount: 500, paid_date: '2026-09-01', method: 'bank_transfer', reference: 'CAT-ONLY-1' })).status).toBe(201);
    const m = await getM(r.body.id);
    expect(m).toMatchObject({ category_id: tiles.id, category_name: tiles.name, category_source: 'category', legacy_category: null, budget_item_name: null });
    const pay = (await pm.get(`${P1}/payments`)).body;
    expect(pay.totals.paid).toBe(500);
    const after = (await pm.get(`${P1}/budget`)).body;
    // no budget item gained paid or scheduled amounts; the summary is unchanged
    for (const it of after.items) {
      const b = before.items.find((x: BItem) => x.id === it.id);
      expect([it.paid_amount, it.scheduled_amount]).toEqual([b.paid_amount, b.scheduled_amount]);
    }
    expect(after.summary).toEqual(before.summary);
  });

  it('linking a budget item sets its category; a conflicting category is rejected; the transfer is counted once', async () => {
    const item = items.find((i) => i.name === 'Contractor Cost')!;
    const other = cats.find((c) => c.id !== item.category_id && !c.archived_at)!;
    expect((await pm.post(`${P1}/payments/milestones`, ms({ budget_item_id: item.id, budget_category_id: other.id }))).status).toBe(400);
    const r = await pm.post(`${P1}/payments/milestones`, ms({ budget_item_id: item.id, scheduled_amount: 4000 }));
    expect(r.status).toBe(201);
    expect(r.body.budget_category_id).toBe(item.category_id);
    await pm.post(`${P1}/payments/milestones/${r.body.id}/transactions`, { amount: 1000, paid_date: '2026-09-02', method: 'bank_transfer', reference: 'ITEM-1' });
    const m = await getM(r.body.id);
    expect(m).toMatchObject({ category_id: item.category_id, category_source: 'budget_item', budget_item_name: 'Contractor Cost' });
    const pay = (await pm.get(`${P1}/payments`)).body;
    expect(pay.totals.paid).toBe(1500); // 500 category-only + 1000 item-linked, each once
    const b = (await pm.get(`${P1}/budget`)).body;
    expect(b.items.find((x: BItem) => x.id === item.id).paid_amount).toBe(1000);
    const sumItems = b.items.reduce((n: number, x: BItem) => n + Number(x.paid_amount), 0);
    expect(sumItems).toBe(1000); // category-only payment is not attributed to a budget line

    // a category alone cannot be changed while the item is linked
    expect((await pm.patch(`${P1}/payments/milestones/${r.body.id}`, { budget_category_id: other.id })).status).toBe(400);
    // explicit unlink keeps the item's category as the editable selection; amounts unchanged
    const un = await pm.patch(`${P1}/payments/milestones/${r.body.id}`, { budget_item_id: null });
    expect(un.status).toBe(200);
    expect(un.body).toMatchObject({ budget_item_id: null, budget_category_id: item.category_id, scheduled_amount: 4000 });
    expect((await getM(r.body.id)).balance.paid).toBe(1000);
    // now the category can be changed
    expect((await pm.patch(`${P1}/payments/milestones/${r.body.id}`, { budget_category_id: other.id })).body.budget_category_id).toBe(other.id);
    // relinking an item takes the item's category
    expect((await pm.patch(`${P1}/payments/milestones/${r.body.id}`, { budget_item_id: item.id })).body.budget_category_id).toBe(item.category_id);
  });

  it('unrelated edits never reclassify; legacy text stays visible for review', async () => {
    const [row] = await q(`INSERT INTO payment_milestones (project_id, payee_type, payee_name, cost_category, description, scheduled_amount)
      VALUES ($1, 'supplier', 'Old supplier', 'Misc site expenses (old)', 'Legacy record', 300) RETURNING id`, [ctx.projects.p1]);
    const r = await pm.patch(`${P1}/payments/milestones/${row.id}`, { description: 'Legacy record (edited)' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ budget_category_id: null, cost_category: 'Misc site expenses (old)' });
    expect(await getM(row.id)).toMatchObject({ category_id: null, legacy_category: 'Misc site expenses (old)', category_label: 'Misc site expenses (old) (legacy)' });
    // classifying it keeps the original text
    const cat = cats.find((c) => !c.archived_at)!;
    expect((await pm.patch(`${P1}/payments/milestones/${row.id}`, { budget_category_id: cat.id })).body).toMatchObject({ budget_category_id: cat.id, cost_category: 'Misc site expenses (old)' });
    const csv = (await pm.get(`${P1}/reports/payments.csv`)).text;
    expect(csv).toContain('Legacy category text (needs review)');
    expect(csv).toContain(`${cat.name},No budget item linked,Misc site expenses (old)`);
  });

  it('archived categories and items: existing links stay viewable and editable, new links are refused', async () => {
    const cat = (await admin.post(`${P1}/categories/budget`, { name: 'Temporary works', kind: 'other' })).body;
    const it = (await admin.post(`${P1}/budget/items`, { category_id: cat.id, name: 'Scaffolding' })).body;
    const m = (await pm.post(`${P1}/payments/milestones`, ms({ budget_item_id: it.id }))).body;
    const m2 = (await pm.post(`${P1}/payments/milestones`, ms({ budget_category_id: cat.id }))).body;
    expect((await admin.post(`${P1}/categories/budget/${cat.id}/archive`)).status).toBe(200);
    expect(await getM(m.id)).toMatchObject({ category_id: cat.id, category_archived_at: expect.any(String), budget_item_name: 'Scaffolding' });
    expect((await pm.patch(`${P1}/payments/milestones/${m.id}`, { notes: 'still editable' })).status).toBe(200);
    expect((await pm.patch(`${P1}/payments/milestones/${m2.id}`, { description: 'Still editable' })).status).toBe(200);
    expect((await pm.patch(`${P1}/payments/milestones/${m2.id}`, { budget_category_id: cat.id })).status).toBe(200); // unchanged link is fine
    expect((await pm.post(`${P1}/payments/milestones`, ms({ budget_category_id: cat.id }))).status).toBe(400);
    expect((await pm.post(`${P1}/payments/milestones`, ms({ budget_item_id: it.id }))).status).toBe(400);
  });

  it('cross-project and role checks', async () => {
    const p2b = (await pm2.get(`${P2}/budget`)).body;
    expect((await pm.post(`${P1}/payments/milestones`, ms({ budget_category_id: p2b.categories[0].id }))).status).toBe(400);
    expect((await pm.post(`${P1}/payments/milestones`, ms({ budget_item_id: p2b.items[0].id }))).status).toBe(400);
    expect((await viewer.post(`${P1}/payments/milestones`, ms({ budget_category_id: cats[0].id }))).status).toBe(403);
    expect((await contractor.get(`${P1}/payments`)).status).toBe(403);
    expect((await pm2.get(`${P1}/payments`)).status).toBe(404);
  });

  it('migration 009 links only unambiguous records, audits them, and is repeatable', async () => {
    const pid = ctx.projects.p1;
    const item = items.find((i) => i.name === 'Contractor Cost')!;
    const floor = cats.find((c) => !c.archived_at && c.kind === 'finishing')!;
    // duplicate name inserted directly (the API refuses duplicates) to create an ambiguous match
    const [dup1] = await q(`INSERT INTO budget_categories (project_id, name, kind) VALUES ($1, 'Ambiguous name', 'other') RETURNING id`, [pid]);
    await q(`INSERT INTO budget_categories (project_id, name, kind) VALUES ($1, 'Ambiguous name', 'finishing')`, [pid]);
    const ins = async (text: string, itemId: string | null) => (await q(`INSERT INTO payment_milestones (project_id, payee_type, payee_name, cost_category, budget_item_id, description, scheduled_amount)
      VALUES ($1, 'supplier', 'S', $2, $3, 'x', 10) RETURNING id`, [pid, text, itemId]))[0].id as string;
    const exact = await ins(`  ${floor.name.toUpperCase()}  `, null);
    const ambiguous = await ins('Ambiguous name', null);
    const unmatched = await ins('Something else entirely', null);
    const viaItem = await ins('Different text', item.id);
    const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '009_payment_categories_site_visits.sql'), 'utf8');
    await ctx.pool.query(sql);
    const rows = await q(`SELECT id, budget_category_id, cost_category FROM payment_milestones WHERE id = ANY($1::uuid[])`, [[exact, ambiguous, unmatched, viaItem]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[exact].budget_category_id).toBe(floor.id);
    expect(by[ambiguous].budget_category_id).toBeNull();
    expect(by[unmatched].budget_category_id).toBeNull();
    expect(by[viaItem].budget_category_id).toBe(item.category_id);
    expect(by[viaItem].cost_category).toBe('Different text'); // original text kept
    expect(dup1).toBeTruthy();
    const audits = await q(`SELECT entity_id, summary FROM audit_log WHERE user_email = 'system (migration 009)' AND entity_id = ANY($1::text[])`, [[exact, ambiguous, unmatched, viaItem]]);
    expect(audits.map((a) => a.entity_id).sort()).toEqual([exact, viaItem].sort());
    expect(audits.find((a) => a.entity_id === viaItem)!.summary).toMatch(/recorded text "Different text" kept for review/);
    // repeatable: a second run changes nothing and adds no audit entries
    await ctx.pool.query(sql);
    expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE user_email = 'system (migration 009)' AND entity_id = ANY($1::text[])`, [[exact, ambiguous, unmatched, viaItem]]))[0].n).toBe(2);
    expect((await getM(viaItem))).toMatchObject({ category_id: item.category_id, legacy_category: 'Different text' });
  });
});

describe('site visits: schedule → summary → findings and follow-up', () => {
  let id = '';
  it('scheduling returns the saved visit in the Scheduled state', async () => {
    const r = await pm.post(`${P1}/visits/site`, { purpose: 'Check tile storage', visit_at: new Date(Date.now() + 2 * 86400e3).toISOString(), assigned_user_id: ctx.users.contractor, areas: 'Store room' });
    expect(r.status).toBe(201);
    id = r.body.id;
    const v = (await pm.get(`${P1}/visits/site`)).body.find((x: { id: string }) => x.id === id);
    expect(v).toMatchObject({ visit_state: 'Scheduled', status: 'Planned', open_action_count: 0, assigned_user_name: 'contractor' });
  });

  it('assigned users can start and complete but not reschedule, cancel, reassign or archive', async () => {
    expect((await contractor.post(`${P1}/visits/site/${id}/reschedule`, { visit_at: new Date().toISOString() })).status).toBe(403);
    expect((await contractor.post(`${P1}/visits/site/${id}/cancel`, { reason: 'x' })).status).toBe(403);
    expect((await contractor.patch(`${P1}/visits/site/${id}`, { assigned_user_id: ctx.users.contractor2 })).status).toBe(403);
    expect((await contractor.post(`${P1}/visits/site/${id}/archive`)).status).toBe(403);
    expect((await contractor2.post(`${P1}/visits/site/${id}/start`)).status).toBe(403); // not assigned
    expect((await viewer.post(`${P1}/visits/site/${id}/start`)).status).toBe(403);
    expect((await pm2.post(`${P2}/visits/site/${id}/start`)).status).toBe(404); // other project
    const s = await contractor.post(`${P1}/visits/site/${id}/start`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: 'In Progress', started_at: expect.any(String) });
    expect((await contractor.post(`${P1}/visits/site/${id}/start`)).status).toBe(400);
    expect((await contractor.patch(`${P1}/visits/site/${id}`, { findings: 'Boxes on the floor', decisions: 'Raise on pallets' })).status).toBe(200);
  });

  it('photos, comments and follow-up actions do not complete the visit; completion keeps actions open', async () => {
    const up = await contractor.upload(`${P1}/attachments`, { entity_type: 'site_visit', entity_id: id, kind: 'site_photo' }, { buf: PNG, name: 'store.png' });
    expect(up.status).toBe(201);
    expect((await contractor.post(`${P1}/visits/site/${id}/comments`, { body: 'Photo uploaded' })).status).toBe(201);
    const a = await pm.post(`${P1}/visits/site/${id}/actions`, { description: 'Buy pallets', responsible_user_id: ctx.users.contractor, due_date: '2026-01-05' });
    expect(a.status).toBe(201);
    let v = (await pm.get(`${P1}/visits/site`)).body.find((x: { id: string }) => x.id === id);
    expect(v).toMatchObject({ status: 'In Progress', attachment_count: 1, comment_count: 1, open_action_count: 1, findings: 'Boxes on the floor', decisions: 'Raise on pallets' });
    expect((await contractor.post(`${P1}/visits/site/${id}/complete`, {})).status).toBe(400); // actual time required
    expect((await contractor.post(`${P1}/visits/site/${id}/complete`, { actual_visit_at: new Date(Date.now() + 86400e3).toISOString() })).status).toBe(400);
    const actual = new Date(Date.now() - 3600e3).toISOString();
    const c = await contractor.post(`${P1}/visits/site/${id}/complete`, { actual_visit_at: actual });
    expect(c.status).toBe(200);
    expect(new Date(c.body.actual_visit_at).toISOString()).toBe(actual);
    v = (await pm.get(`${P1}/visits/site`)).body.find((x: { id: string }) => x.id === id);
    expect(v).toMatchObject({ visit_state: 'Completed', open_action_count: 1 });
    expect(v.actions[0]).toMatchObject({ status: 'Open' });
    expect((await pm.post(`${P1}/visits/site/${id}/complete`, { actual_visit_at: actual })).status).toBe(400);
    expect((await pm.post(`${P1}/visits/site/${id}/reschedule`, { visit_at: new Date().toISOString() })).status).toBe(400);
    expect((await pm.post(`${P1}/visits/site/${id}/cancel`, { reason: 'x' })).status).toBe(400);
    // dashboard: the overdue open action of a completed visit is surfaced and links to the visit
    const d = (await pm.get(`${P1}/dashboard`)).body;
    expect(d.overdueSiteActions).toEqual([expect.objectContaining({ visit_id: id, description: 'Buy pallets', who: 'contractor' })]);
    const hist = (await pm.get(`${P1}/visits/site/${id}/history`)).body.map((h: { summary: string }) => h.summary).join('\n');
    expect(hist).toMatch(/Started site visit/);
    expect(hist).toMatch(/completed \(visited/);
  });

  it('reschedule records old and new times; cancel needs a reason; cancelled visits leave upcoming and reminders', async () => {
    const t1 = new Date(Date.now() + 3 * 86400e3);
    const r = (await pm.post(`${P1}/visits/site`, { purpose: 'Snagging walk', visit_at: t1.toISOString(), assigned_user_id: ctx.users.contractor })).body;
    const t2 = new Date(Date.now() + 5 * 86400e3);
    const rs = await pm.post(`${P1}/visits/site/${r.id}/reschedule`, { visit_at: t2.toISOString(), reason: 'Contractor request' });
    expect(rs.status).toBe(200);
    expect(rs.body.status).toBe('Rescheduled');
    const hist = (await pm.get(`${P1}/visits/site/${r.id}/history`)).body[0].summary;
    expect(hist).toContain(t1.toISOString().slice(0, 16).replace('T', ' '));
    expect(hist).toContain(t2.toISOString().slice(0, 16).replace('T', ' '));
    expect(hist).toContain('Contractor request');
    expect((await pm.get(`${P1}/dashboard`)).body.upcoming.some((u: { id: string }) => u.id === r.id)).toBe(true);
    await pm.post(`${P1}/visits/site/${r.id}/actions`, { description: 'Old snag', due_date: '2026-01-01' });
    expect((await pm.post(`${P1}/visits/site/${r.id}/cancel`, {})).status).toBe(400);
    expect((await pm.patch(`${P1}/visits/site/${r.id}`, { status: 'Cancelled' })).status).toBe(400);
    const cn = await pm.post(`${P1}/visits/site/${r.id}/cancel`, { reason: 'Owner travelling' });
    expect(cn.body).toMatchObject({ status: 'Cancelled', cancel_reason: 'Owner travelling' });
    const d = (await pm.get(`${P1}/dashboard`)).body;
    expect(d.upcoming.some((u: { id: string }) => u.id === r.id)).toBe(false);
    expect(d.overdueSiteActions.some((a: { visit_id: string }) => a.visit_id === r.id)).toBe(false);
    // the assignee is told about the cancellation once (existing notification infrastructure)
    await ctx.notifier.flush();
    const n = await q(`SELECT user_id, url FROM notifications WHERE entity_id = $1 AND kind = 'site_visit.cancelled'`, [r.id]);
    expect(n).toEqual([expect.objectContaining({ user_id: ctx.users.contractor, url: expect.stringContaining(`/site/${ctx.projects.p1}/${r.id}`) })]);
    // reopen with reschedule
    expect((await pm.post(`${P1}/visits/site/${r.id}/reschedule`, { visit_at: t2.toISOString() })).body).toMatchObject({ status: 'Rescheduled', cancel_reason: '' });
  });

  it('existing site visits keep their data; no actual date is inferred', async () => {
    const [old] = await q(`INSERT INTO site_visits (project_id, visit_at, assigned_name, purpose, status, findings)
      VALUES ($1, '2026-05-01T06:00:00Z', 'Old foreman', 'Historic visit', 'Completed', 'All good') RETURNING id`, [ctx.projects.p1]);
    const v = (await pm.get(`${P1}/visits/site`)).body.find((x: { id: string }) => x.id === old.id);
    expect(v).toMatchObject({ visit_state: 'Completed', actual_visit_at: null, assigned_name: 'Old foreman', findings: 'All good', decisions: '', cancel_reason: '' });
    expect((await pm.patch(`${P1}/visits/site/${old.id}`, { notes: 'reviewed' })).body).toMatchObject({ actual_visit_at: null, status: 'Completed' });
  });

  it('consultant visits still work', async () => {
    const c = await pm.post(`${P1}/visits/consultant`, { purpose: 'Slab inspection', planned_at: new Date(Date.now() + 86400e3).toISOString() });
    expect(c.status).toBe(201);
    expect((await pm.post(`${P1}/visits/consultant/${c.body.id}/cancel`, { reason: 'x' })).body.status).toBe('Cancelled');
    expect((await pm.get(`${P1}/visits/consultant`)).body.find((x: { id: string }) => x.id === c.body.id)).toMatchObject({ visit_state: 'Cancelled' });
  });
});
