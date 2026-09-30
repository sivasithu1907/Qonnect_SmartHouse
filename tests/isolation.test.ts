import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Ctx } from './helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });
afterAll(async () => { await ctx.close(); });

describe('project isolation', () => {
  it('non-admin users only list their assigned projects', async () => {
    const pm2 = await ctx.agent('pm2');
    const list = await pm2.get('/api/projects');
    expect(list.body.map((p: { code: string }) => p.code)).toEqual(['PIN 70153016']);
    const port = await pm2.get('/api/portfolio');
    expect(port.body).toHaveLength(1);
    const out = await ctx.agent('outsider');
    expect((await out.get('/api/projects')).body).toEqual([]);
  });

  it('unassigned projects return 404 for every endpoint', async () => {
    const pm2 = await ctx.agent('pm2');
    for (const path of ['', '/dashboard', '/budget', '/payments', '/materials', '/visits/consultant', '/visits/site', '/timeline', '/audit', '/reports/payments.csv']) {
      expect((await pm2.get(`/api/projects/${ctx.projects.p1}${path}`)).status).toBe(404);
    }
    expect((await pm2.post(`/api/projects/${ctx.projects.p1}/materials`, { category: 'X', description: 'Y' })).status).toBe(404);
  });

  it('a record id from project 1 cannot be read or changed through project 2', async () => {
    const admin = await ctx.agent('admin');
    const mats = await admin.get(`/api/projects/${ctx.projects.p1}/materials`);
    const matId = mats.body.items[0].id;
    const r = await admin.patch(`/api/projects/${ctx.projects.p2}/materials/${matId}`, { notes: 'hijack' });
    expect(r.status).toBe(404);
    const ms = await admin.post(`/api/projects/${ctx.projects.p1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'C', description: 'Adv', scheduled_amount: 100 });
    expect(ms.status).toBe(201);
    expect((await admin.post(`/api/projects/${ctx.projects.p2}/payments/milestones/${ms.body.id}/transactions`, { amount: 10, paid_date: '2026-01-01', method: 'cash' })).status).toBe(404);
    // cross-project foreign key: linking P2 milestone to a P1 budget item is rejected
    const b1 = await admin.get(`/api/projects/${ctx.projects.p1}/budget`);
    const r2 = await admin.post(`/api/projects/${ctx.projects.p2}/payments/milestones`, { payee_type: 'contractor', payee_name: 'C', description: 'x', scheduled_amount: 5, budget_item_id: b1.body.items[0].id });
    expect(r2.status).toBe(400);
  });

  it('totals stay isolated per project', async () => {
    const admin = await ctx.agent('admin');
    const d2 = await admin.get(`/api/projects/${ctx.projects.p2}/dashboard`);
    expect(d2.body.finance).toMatchObject({ paid: 0, pending: 0, scheduled: 0, approvedCommitments: 0 });
    expect(d2.body.materials.total).toBe(0);
    const d1 = await admin.get(`/api/projects/${ctx.projects.p1}/dashboard`);
    expect(d1.body.finance.pending).toBe(100);
    expect(d1.body.materials.total).toBe(40);
  });

  it('archived projects are hidden from non-admins and read-only for admins', async () => {
    const admin = await ctx.agent('admin');
    expect((await admin.post(`/api/projects/${ctx.projects.p2}/archive`)).status).toBe(200);
    const pm2 = await ctx.agent('pm2');
    expect((await pm2.get(`/api/projects/${ctx.projects.p2}`)).status).toBe(404);
    expect((await admin.post(`/api/projects/${ctx.projects.p2}/materials`, { category: 'A', description: 'B' })).status).toBe(409);
    expect((await admin.post(`/api/projects/${ctx.projects.p2}/restore`)).status).toBe(200);
    expect((await pm2.get(`/api/projects/${ctx.projects.p2}`)).status).toBe(200);
  });

  it('rejects malformed ids without leaking errors', async () => {
    const admin = await ctx.agent('admin');
    expect((await admin.get(`/api/projects/not-a-uuid/budget`)).status).toBe(404);
    expect((await admin.patch(`/api/projects/${ctx.projects.p1}/materials/xyz`, {})).status).toBe(404);
  });
});
