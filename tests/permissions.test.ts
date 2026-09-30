import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Ctx } from './helpers';

let ctx: Ctx;
let P: string;
beforeAll(async () => { ctx = await setup(); P = `/api/projects/${ctx.projects.p1}`; });
afterAll(async () => { await ctx.close(); });

describe('role permissions (server-enforced)', () => {
  it('viewer can read everything in the project but cannot write', async () => {
    const v = await ctx.agent('viewer');
    for (const p of ['/budget', '/payments', '/materials', '/timeline', '/visits/consultant', '/visits/site']) expect((await v.get(P + p)).status).toBe(200);
    const mats = await v.get(P + '/materials');
    expect((await v.patch(`${P}/materials/${mats.body.items[0].id}`, { notes: 'x' })).status).toBe(403);
    expect((await v.post(`${P}/payments/milestones`, { payee_type: 'other', payee_name: 'x', description: 'x', scheduled_amount: 1 })).status).toBe(403);
    expect((await v.patch(`${P}/links`, { sheets_url: 'https://x.test' })).status).toBe(403);
    expect((await v.get(P + '/audit')).status).toBe(403);
  });

  it('contractor and consultant cannot see budget or payments (including dashboard finance)', async () => {
    for (const k of ['contractor', 'consultant']) {
      const a = await ctx.agent(k);
      expect((await a.get(P + '/budget')).status).toBe(403);
      expect((await a.get(P + '/payments')).status).toBe(403);
      expect((await a.get(P + '/reports/payments.csv')).status).toBe(403);
      const d = await a.get(P + '/dashboard');
      expect(d.status).toBe(200);
      expect(d.body.finance).toBeNull();
    }
  });

  it('project manager manages day-to-day records but not budgets, projects or users', async () => {
    const pm = await ctx.agent('pm');
    const b = await pm.get(P + '/budget');
    expect(b.status).toBe(200);
    expect((await pm.patch(`${P}/budget/items/${b.body.items[0].id}`, { approved_amount: 1 })).status).toBe(403);
    expect((await pm.post(`${P}/budget/categories`, { name: 'X' })).status).toBe(403);
    expect((await pm.patch(`${P}/settings`, { misc_percentage: 12 })).status).toBe(403);
    expect((await pm.patch(P, { name: 'Renamed' })).status).toBe(403);
    expect((await pm.post(`${P}/archive`)).status).toBe(403);
    expect((await pm.post('/api/projects', { code: 'X-1', name: 'X' })).status).toBe(403);
    expect((await pm.get('/api/users')).status).toBe(403);
    expect((await pm.patch(`${P}/links`, { drive_folder_url: 'https://drive.google.com/drive/folders/abc' })).status).toBe(200);
    expect((await pm.post(`${P}/payments/milestones`, { payee_type: 'kahramaa', payee_name: 'Kahramaa', description: 'Connection', scheduled_amount: 10 })).status).toBe(201);
  });

  it('contractor may update only assigned material lines and only delivery-type fields', async () => {
    const admin = await ctx.agent('admin');
    const mats = (await admin.get(P + '/materials')).body.items;
    const [m1, m2] = mats;
    expect((await admin.patch(`${P}/materials/${m1.id}`, { assigned_contractor_id: ctx.users.contractor })).status).toBe(200);
    // cannot assign a non-contractor
    expect((await admin.patch(`${P}/materials/${m2.id}`, { assigned_contractor_id: ctx.users.viewer })).status).toBe(400);
    const c = await ctx.agent('contractor');
    const ok = await c.patch(`${P}/materials/${m1.id}`, { status: 'Ordered', planned_delivery_date: '2026-10-08', qty_ordered: 100 });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('Ordered');
    expect((await c.patch(`${P}/materials/${m1.id}`, { supply_responsibility: 'contractor' })).status).toBe(403);
    expect((await c.patch(`${P}/materials/${m1.id}`, { required_on_site_date: '2026-12-01' })).status).toBe(403);
    expect((await c.patch(`${P}/materials/${m2.id}`, { status: 'Ordered' })).status).toBe(403);
    const c2 = await ctx.agent('contractor2');
    expect((await c2.patch(`${P}/materials/${m1.id}`, { status: 'Delivered' })).status).toBe(403);
    expect((await c.post(`${P}/materials`, { category: 'X', description: 'Y' })).status).toBe(403);
  });

  it('contractor can post work updates and edit only their own', async () => {
    const c = await ctx.agent('contractor');
    const w = await c.post(`${P}/work-updates`, { update_date: '2026-09-30', title: 'Blockwork started on ground floor' });
    expect(w.status).toBe(201);
    const c2 = await ctx.agent('contractor2');
    expect((await c2.patch(`${P}/work-updates/${w.body.id}`, { title: 'x' })).status).toBe(403);
    const v = await ctx.agent('viewer');
    expect((await v.post(`${P}/work-updates`, { update_date: '2026-09-30', title: 'x' })).status).toBe(403);
  });

  it('consultant manages only their own visits', async () => {
    const con = await ctx.agent('consultant');
    const v = await con.post(`${P}/visits/consultant`, { purpose: 'Waterproofing inspection', planned_at: '2026-10-05T07:00:00.000Z' });
    expect(v.status).toBe(201);
    expect(v.body.consultant_user_id).toBe(ctx.users.consultant);
    expect((await con.patch(`${P}/visits/consultant/${v.body.id}`, { status: 'Completed', observations: 'Flood test passed on roof' })).status).toBe(200);
    expect((await con.post(`${P}/visits/consultant/${v.body.id}/actions`, { description: 'Seal drain at bathroom 2', responsible: 'Contractor' })).status).toBe(201);
    const con2 = await ctx.agent('consultant2');
    expect((await con2.patch(`${P}/visits/consultant/${v.body.id}`, { observations: 'x' })).status).toBe(403);
    const c = await ctx.agent('contractor');
    expect((await c.post(`${P}/visits/consultant`, { purpose: 'x' })).status).toBe(403);
    expect((await con.post(`${P}/visits/site`, { purpose: 'x' })).status).toBe(403);
  });

  it('site visit assignee may update findings and status only', async () => {
    const pm = await ctx.agent('pm');
    const s = await pm.post(`${P}/visits/site`, { purpose: 'Check tile storage', assigned_user_id: ctx.users.contractor, visit_at: '2026-10-02T06:00:00.000Z' });
    expect(s.status).toBe(201);
    const c = await ctx.agent('contractor');
    expect((await c.patch(`${P}/visits/site/${s.body.id}`, { status: 'Completed', findings: 'Stored under cover' })).status).toBe(200);
    expect((await c.patch(`${P}/visits/site/${s.body.id}`, { purpose: 'changed' })).status).toBe(403);
    const c2 = await ctx.agent('contractor2');
    expect((await c2.patch(`${P}/visits/site/${s.body.id}`, { findings: 'x' })).status).toBe(403);
  });

  it('admin manages users and project assignments', async () => {
    const admin = await ctx.agent('admin');
    const u = await admin.post('/api/users', { email: 'newpm@test.local', name: 'New PM', role: 'project_manager', password: 'LongEnoughPass1', projectIds: [ctx.projects.p2] });
    expect(u.status).toBe(201);
    expect((await admin.post('/api/users', { email: 'NEWPM@test.local', name: 'dup', role: 'viewer', password: 'LongEnoughPass1' })).status).toBe(409);
    const list = await admin.get('/api/users');
    expect(list.body.find((x: { email: string }) => x.email === 'newpm@test.local').project_ids).toEqual([ctx.projects.p2]);
    expect(JSON.stringify(list.body)).not.toMatch(/scrypt/);
  });
});
