// Prerequisites & documents: project isolation, roles, recorded decisions, document links,
// uploads that never change status, reorder / archive, audit and archived projects.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF, setup, type Agent, type Ctx } from './helpers';
import { addDaysISO, todayISO } from '../shared/calc';

let ctx: Ctx;
let P1 = '';
let P2 = '';
let admin: Agent;
let pm: Agent;
let pm2: Agent;
let viewer: Agent;
let contractor: Agent;
let consultant: Agent;
let today = '';
let phase1 = '';
let phaseP2 = '';
let contract1 = '';
let contractP2 = '';
let a = '';
let b = '';
let c = '';

beforeAll(async () => {
  ctx = await setup();
  P1 = `/api/projects/${ctx.projects.p1}`;
  P2 = `/api/projects/${ctx.projects.p2}`;
  [admin, pm, pm2, viewer, contractor, consultant] = await Promise.all(['admin', 'pm', 'pm2', 'viewer', 'contractor', 'consultant'].map((k) => ctx.agent(k)));
  today = todayISO(ctx.cfg.timeZone);
  phase1 = (await admin.get(`${P1}/timeline`)).body.phases[2].id;
  phaseP2 = (await admin.get(`${P2}/timeline`)).body.phases[0].id;
  const cat1 = (await admin.get(`${P1}/categories`)).body.contract[0].id;
  const catP2 = (await admin.get(`${P2}/categories`)).body.contract[0].id;
  contract1 = (await pm.post(`${P1}/contracts`, { title: 'Main construction agreement', category_id: cat1, company_name: 'Builder Co', status: 'Signed' })).body.id;
  contractP2 = (await admin.post(`${P2}/contracts`, { title: 'P2 agreement', category_id: catP2, company_name: 'Other Co' })).body.id;
});
afterAll(async () => { await ctx.close(); });

describe('starting state', () => {
  it('no project has prerequisites until someone adds them', async () => {
    expect((await pm.get(`${P1}/prerequisites`)).body).toEqual([]);
    expect((await admin.get(`${P2}/prerequisites`)).body).toEqual([]);
    expect((await ctx.pool.query('SELECT count(*)::int n FROM project_prerequisites')).rows[0].n).toBe(0);
  });
});

describe('create and edit', () => {
  it('a project manager adds items in order, linked to a phase, a member and a contract of the same project', async () => {
    const r1 = await pm.post(`${P1}/prerequisites`, { title: 'Building permit', phase_id: phase1, responsible_user_id: ctx.users.pm, due_date: addDaysISO(today, 10) });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ status: 'Not started', completed_on: null, decided_at: null, sort_order: 1 });
    a = r1.body.id;
    b = (await pm.post(`${P1}/prerequisites`, { title: 'Main contractor agreement', contract_id: contract1, responsible_name: 'Owner' })).body.id;
    c = (await pm.post(`${P1}/prerequisites`, { title: 'Civil Defence approval', document_url: 'https://drive.google.com/file/d/x' })).body.id;
    const list = (await viewer.get(`${P1}/prerequisites`)).body;
    expect(list.map((x: any) => x.title)).toEqual(['Building permit', 'Main contractor agreement', 'Civil Defence approval']);
    expect(list[0]).toMatchObject({ phase_id: phase1, responsible_display: 'pm', attachment_count: 0 });
    expect(list[0].phase_seq).toBe(3);
    expect(list[1]).toMatchObject({ contract_title: 'Main construction agreement', contract_status: 'Signed', responsible_display: 'Owner' });
    const audits = await ctx.pool.query(`SELECT action FROM audit_log WHERE entity_type = 'prerequisite' ORDER BY id`);
    expect(audits.rows.map((r) => r.action)).toEqual(['create', 'create', 'create']);
  });

  it('rejects links to another project, non-members and bad input', async () => {
    expect((await pm.post(`${P1}/prerequisites`, { title: 'X', phase_id: phaseP2 })).status).toBe(400);
    expect((await pm.post(`${P1}/prerequisites`, { title: 'X', contract_id: contractP2 })).status).toBe(400);
    expect((await pm.post(`${P1}/prerequisites`, { title: 'X', responsible_user_id: ctx.users.pm2 })).status).toBe(400);
    expect((await pm.post(`${P1}/prerequisites`, { title: '' })).status).toBe(400);
    expect((await pm.post(`${P1}/prerequisites`, { title: 'X', document_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await pm.patch(`${P1}/prerequisites/${a}`, { contract_id: contractP2 })).status).toBe(400);
  });
});

describe('recorded decisions', () => {
  it('uploading a document does not change the status', async () => {
    const up = await pm.upload(`${P1}/attachments`, { entity_type: 'prerequisite', entity_id: a, kind: 'supporting_document' }, { buf: PDF, name: 'permit.pdf' });
    expect(up.status).toBe(201);
    const row = (await pm.get(`${P1}/prerequisites`)).body.find((x: any) => x.id === a);
    expect(row).toMatchObject({ status: 'Not started', attachment_count: 1, decided_at: null });
    // opening it is allowed for readers and does not touch the record
    expect((await viewer.get(`${P1}/attachments/${up.body.id}/download?inline=1`)).status).toBe(200);
    expect((await pm.get(`${P1}/prerequisites`)).body.find((x: any) => x.id === a).status).toBe('Not started');
    // only prerequisite document types are accepted
    expect((await pm.upload(`${P1}/attachments`, { entity_type: 'prerequisite', entity_id: a, kind: 'payment_slip' }, { buf: PDF, name: 'x.pdf' })).status).toBe(400);
  });

  it('Completed records who decided, when, and the completion date; a future date is refused', async () => {
    expect((await pm.patch(`${P1}/prerequisites/${a}`, { status: 'Completed', completed_on: addDaysISO(today, 1) })).status).toBe(400);
    const r = await pm.patch(`${P1}/prerequisites/${a}`, { status: 'Completed', completed_on: addDaysISO(today, -2) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'Completed', completed_on: addDaysISO(today, -2), decided_by: ctx.users.pm });
    expect(r.body.decided_at).toBeTruthy();
    const row = (await viewer.get(`${P1}/prerequisites`)).body.find((x: any) => x.id === a);
    expect(row.decided_by_name).toBe('pm');
    const audit = await ctx.pool.query(`SELECT action, summary FROM audit_log WHERE entity_type = 'prerequisite' AND entity_id = $1 AND action = 'status'`, [a]);
    expect(audit.rows[0].summary).toContain('Not started → Completed');
  });

  it('Completed without a date uses today; moving back clears the decision; Not applicable records a decision without a date', async () => {
    const r = await pm.patch(`${P1}/prerequisites/${b}`, { status: 'Completed' });
    expect(r.body.completed_on).toBe(today);
    const back = await pm.patch(`${P1}/prerequisites/${b}`, { status: 'In progress' });
    expect(back.body).toMatchObject({ status: 'In progress', completed_on: null, decided_by: null, decided_at: null });
    const na = await admin.patch(`${P1}/prerequisites/${c}`, { status: 'Not applicable' });
    expect(na.body).toMatchObject({ status: 'Not applicable', completed_on: null, decided_by: ctx.users.admin });
    expect((await pm.patch(`${P1}/prerequisites/${b}`, { completed_on: today })).status).toBe(400); // only for completed items
  });
});

describe('roles and isolation', () => {
  it('viewers read only; contractors and consultants have no access', async () => {
    expect((await viewer.post(`${P1}/prerequisites`, { title: 'X' })).status).toBe(403);
    expect((await viewer.patch(`${P1}/prerequisites/${a}`, { title: 'X' })).status).toBe(403);
    expect((await viewer.upload(`${P1}/attachments`, { entity_type: 'prerequisite', entity_id: a, kind: 'supporting_document' }, { buf: PDF, name: 'x.pdf' })).status).toBe(403);
    for (const ag of [contractor, consultant]) {
      expect((await ag.get(`${P1}/prerequisites`)).status).toBe(403);
      expect((await ag.get(`${P1}/attachments?entity_type=prerequisite&entity_id=${a}`)).status).toBe(403);
    }
  });

  it('records never leak to another project', async () => {
    expect((await pm2.get(`${P1}/prerequisites`)).status).toBe(404);
    expect((await admin.patch(`${P2}/prerequisites/${a}`, { title: 'hijack' })).status).toBe(404);
    expect((await admin.post(`${P2}/prerequisites/${a}/archive`)).status).toBe(404);
    expect((await admin.get(`${P2}/prerequisites`)).body).toEqual([]);
    expect((await admin.upload(`${P2}/attachments`, { entity_type: 'prerequisite', entity_id: a, kind: 'supporting_document' }, { buf: PDF, name: 'x.pdf' })).status).toBe(404);
  });
});

describe('reorder and archive', () => {
  it('reorders active items, archives and restores (audited)', async () => {
    expect((await pm.post(`${P1}/prerequisites/reorder`, { ids: [c, a] })).status).toBe(400); // must send all
    const r = await pm.post(`${P1}/prerequisites/reorder`, { ids: [c, a, b] });
    expect(r.status).toBe(200);
    expect(r.body.map((x: any) => x.id)).toEqual([c, a, b]);
    expect((await pm.post(`${P1}/prerequisites/${c}/archive`)).status).toBe(200);
    expect((await pm.get(`${P1}/prerequisites`)).body.map((x: any) => x.id)).toEqual([a, b]);
    expect((await pm.get(`${P1}/prerequisites?includeArchived=1`)).body.map((x: any) => x.id)).toEqual([a, b, c]);
    expect((await pm.patch(`${P1}/prerequisites/${c}`, { title: 'x' })).status).toBe(400);
    expect((await pm.post(`${P1}/prerequisites/${c}/restore`)).status).toBe(200);
    expect((await pm.get(`${P1}/prerequisites`)).body.map((x: any) => x.id)).toEqual([a, b, c]);
    const actions = (await ctx.pool.query(`SELECT action FROM audit_log WHERE entity_type = 'prerequisite' AND action IN ('reorder','archive','restore') ORDER BY id`)).rows.map((x) => x.action);
    expect(actions).toEqual(['reorder', 'archive', 'restore']);
  });

  it('archived projects are read-only', async () => {
    const p = (await admin.post(`${P2}/prerequisites`, { title: 'Soil report' })).body.id;
    expect((await admin.post(`${P2}/archive`)).status).toBe(200);
    expect((await admin.post(`${P2}/prerequisites`, { title: 'X' })).status).toBe(409);
    expect((await admin.patch(`${P2}/prerequisites/${p}`, { status: 'Completed' })).status).toBe(409);
    expect((await admin.get(`${P2}/prerequisites`)).status).toBe(200);
  });
});
