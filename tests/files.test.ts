import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDF, PNG, setup, type Ctx, type Agent } from './helpers';

let ctx: Ctx;
let P: string;
let pm: Agent;
let txId = '';
let materialId = '';
beforeAll(async () => {
  ctx = await setup();
  P = `/api/projects/${ctx.projects.p1}`;
  pm = await ctx.agent('pm');
  const m = await pm.post(P + '/payments/milestones', { payee_type: 'consultant', payee_name: 'Consultant', description: 'Visit fee', scheduled_amount: 1000 });
  const t = await pm.post(`${P}/payments/milestones/${m.body.id}/transactions`, { amount: 1000, paid_date: '2026-09-01', method: 'bank_transfer', reference: 'SLIP-1' });
  txId = t.body.id;
  materialId = (await pm.get(P + '/materials')).body.items[0].id;
});
afterAll(async () => { await ctx.close(); });

describe('secure uploads', () => {
  let fileId = '';
  it('stores a payment slip privately with a random name', async () => {
    const r = await pm.upload(P + '/attachments', { entity_type: 'payment_transaction', entity_id: txId, kind: 'payment_slip' }, { buf: PDF, name: 'slip "1".pdf' });
    expect(r.status).toBe(201);
    fileId = r.body.id;
    expect(r.body.mime_type).toBe('application/pdf');
    const row = (await ctx.pool.query('SELECT stored_name, project_id FROM attachments WHERE id = $1', [fileId])).rows[0];
    expect(row.stored_name).not.toContain('slip');
    expect(fs.existsSync(path.join(ctx.uploadDir, row.project_id, row.stored_name))).toBe(true);
  });

  it('serves downloads only to users allowed to read payments in that project', async () => {
    const ok = await pm.get(`${P}/attachments/${fileId}/download`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['content-disposition']).toMatch(/^attachment;/);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect((await (await ctx.agent('viewer')).get(`${P}/attachments/${fileId}/download`)).status).toBe(200);
    expect((await (await ctx.agent('contractor')).get(`${P}/attachments/${fileId}/download`)).status).toBe(403);
    expect((await (await ctx.agent('pm2')).get(`${P}/attachments/${fileId}/download`)).status).toBe(404);
    // same file id through the other project path
    expect((await (await ctx.agent('admin')).get(`/api/projects/${ctx.projects.p2}/attachments/${fileId}/download`)).status).toBe(404);
  });

  it('rejects unsupported types, spoofed extensions, and oversized files', async () => {
    const fields = { entity_type: 'payment_transaction', entity_id: txId, kind: 'payment_slip' };
    expect((await pm.upload(P + '/attachments', fields, { buf: Buffer.from('<script>alert(1)</script>'), name: 'x.pdf' })).status).toBe(415);
    expect((await pm.upload(P + '/attachments', fields, { buf: Buffer.from('MZ\x90\x00'), name: 'x.exe' })).status).toBe(415);
    const big = Buffer.concat([PDF, Buffer.alloc(1.2 * 1024 * 1024)]);
    expect((await pm.upload(P + '/attachments', fields, { buf: big, name: 'big.pdf' })).status).toBe(413);
  });

  it('site photos must be images', async () => {
    const pmS = await pm.post(P + '/visits/site', { purpose: 'Photo check' });
    expect((await pm.upload(P + '/attachments', { entity_type: 'site_visit', entity_id: pmS.body.id, kind: 'site_photo' }, { buf: PDF, name: 'a.pdf' })).status).toBe(400);
    expect((await pm.upload(P + '/attachments', { entity_type: 'site_visit', entity_id: pmS.body.id, kind: 'site_photo' }, { buf: PNG, name: 'a.png' })).status).toBe(201);
  });

  it('contractor can upload delivery notes only to materials assigned to them', async () => {
    const c = await ctx.agent('contractor');
    const f = { entity_type: 'material', entity_id: materialId, kind: 'delivery_note' };
    expect((await c.upload(P + '/attachments', f, { buf: PDF, name: 'dn.pdf' })).status).toBe(403);
    const admin = await ctx.agent('admin');
    await admin.patch(`${P}/materials/${materialId}`, { assigned_contractor_id: ctx.users.contractor });
    expect((await c.upload(P + '/attachments', f, { buf: PDF, name: 'dn.pdf' })).status).toBe(201);
    expect((await c.upload(P + '/attachments', { entity_type: 'payment_transaction', entity_id: txId, kind: 'payment_slip' }, { buf: PDF, name: 'p.pdf' })).status).toBe(403);
  });

  it('archived files are no longer downloadable; viewers cannot archive', async () => {
    expect((await (await ctx.agent('viewer')).post(`${P}/attachments/${fileId}/archive`)).status).toBe(403);
    expect((await pm.post(`${P}/attachments/${fileId}/archive`)).status).toBe(200);
    expect((await pm.get(`${P}/attachments/${fileId}/download`)).status).toBe(404);
  });

  it('requires authentication for downloads', async () => {
    const { default: request } = await import('supertest');
    expect((await request(ctx.app).get(`${P}/attachments/${fileId}/download`)).status).toBe(401);
  });
});
