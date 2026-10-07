// Contacts / Companies directory: shared entries, contact people, project assignments, permissions,
// project isolation (list, search, details, duplicate checks, documents, related records), manual
// linking that never changes amounts or historical names, and archiving without broken links.
// Isolated test fixtures only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PDF, setup, type Agent, type Ctx } from './helpers';
import { findDuplicates, formatPhone, normalizePhone, similarNames, whatsappUrl } from '../shared/directory';

describe('phone and name helpers (pure)', () => {
  it('normalizes Qatar and international numbers for matching but keeps a readable display', () => {
    for (const v of ['55123456', '5512 3456', '+974 5512 3456', '00974-5512-3456', '974 55123456']) expect(normalizePhone(v)).toBe('97455123456');
    expect(normalizePhone('+91 98765 43210')).toBe('919876543210');
    expect(normalizePhone('0094 77 123 4567')).toBe('94771234567');
    expect(normalizePhone('12')).toBe('');
    expect(formatPhone('55123456')).toBe('+974 5512 3456');
    expect(formatPhone('+91 98765 43210')).toBe('+91 9876543210');
    expect(whatsappUrl('5512 3456')).toBe('https://wa.me/97455123456');
  });
  it('similar names ignore case, punctuation and legal / trading words', () => {
    expect(similarNames('Mokkabbir Trading & Contracting W.L.L.', 'MOKKABBIR')).toBe(true);
    expect(similarNames('Al Mana Gypsum', 'Al-Mana Gypsum Est.')).toBe(true);
    expect(similarNames('Doha Tiles', 'Qatar Marble')).toBe(false);
  });
  it('duplicate reasons are hints with cautions for shared numbers / mailboxes', () => {
    const c = { id: 'x', ref: 'DIR-0001', display_name: 'Gulf Gypsum WLL', entity_type: 'company', archived_at: null, phone_normalized: '97444001122', email: 'info@gulf.qa', registration_no: 'CR-1', contacts: [] };
    const m = findDuplicates({ display_name: 'Other name', phone: '4400 1122', email: 'INFO@gulf.qa' }, [c]);
    expect(m[0].reasons).toEqual(['Same phone number', 'Same email']);
    expect(m[0].caution.join(' ')).toMatch(/shared office number/);
    expect(m[0].caution.join(' ')).toMatch(/general office mailbox/);
    expect(findDuplicates({ registration_no: 'cr-1' }, [c])[0].reasons).toEqual(['Same registration / reference number']);
    expect(findDuplicates({ display_name: 'Gulf Gypsum' }, [c], 'x')).toEqual([]);
  });
});

describe('directory API (isolated test projects)', () => {
  let ctx: Ctx;
  let admin: Agent; let pm: Agent; let pm2: Agent; let viewer: Agent; let contractor: Agent; let consultant: Agent; let outsider: Agent;
  let P1 = ''; let P2 = '';
  let gypsum = ''; let gypsumRef = '';
  let ali = ''; let sara = '';
  let solo = '';
  const q = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;
  beforeAll(async () => {
    ctx = await setup();
    [admin, pm, pm2, viewer, contractor, consultant, outsider] = await Promise.all(['admin', 'pm', 'pm2', 'viewer', 'contractor', 'consultant', 'outsider'].map((k) => ctx.agent(k)));
    P1 = ctx.projects.p1; P2 = ctx.projects.p2;
  });
  afterAll(async () => { await ctx.close(); });

  it('creates a company with several roles and an independent individual; nothing else is created', async () => {
    const before = { users: (await q('SELECT count(*)::int n FROM users'))[0].n, members: (await q('SELECT count(*)::int n FROM project_members'))[0].n };
    const r = await admin.post('/api/directory', { display_name: 'Gulf Gypsum Contracting WLL', entity_type: 'company', roles: ['finishing_contractor', 'subcontractor'], specializations: ['Gypsum', 'Painting'], phone: '4400 1122', email: 'info@gulfgypsum.qa', registration_no: 'CR-12345' });
    expect(r.status).toBe(201);
    expect(r.body.ref).toMatch(/^DIR-\d{4}$/);
    expect(r.body.roles).toEqual(['finishing_contractor', 'subcontractor']);
    gypsum = r.body.id; gypsumRef = r.body.ref;
    expect((await q('SELECT phone, phone_normalized FROM directory_entries WHERE id = $1', [gypsum]))[0]).toEqual({ phone: '4400 1122', phone_normalized: '97444001122' });
    const s = await pm.post('/api/directory', { display_name: 'Eng. Samir Haddad', entity_type: 'individual', roles: ['consultant'] });
    expect(s.status).toBe(201); // only name, type and role are required; no contact person needed
    solo = s.body.id;
    expect((await pm.post('/api/directory', { display_name: 'x', entity_type: 'company', roles: [] })).status).toBe(400);
    expect((await pm.post('/api/directory', { display_name: 'x', entity_type: 'company', roles: ['other'], specializations: ['Rocket science'] })).status).toBe(400);
    for (const a of [viewer, contractor, consultant]) expect((await a.post('/api/directory', { display_name: 'x', entity_type: 'company', roles: ['other'] })).status).toBe(403);
    expect((await q('SELECT count(*)::int n FROM users'))[0].n).toBe(before.users);
    expect((await q('SELECT count(*)::int n FROM project_members'))[0].n).toBe(before.members);
  });

  it('multiple contact people with one primary; adding contacts creates no login', async () => {
    ali = (await pm.post(`/api/directory/${gypsum}/contacts`, { name: 'Ali Hassan', position: 'Project Engineer', mobile: '+974 5512 3456', email: 'ali@gulfgypsum.qa', is_primary: true })).body.id;
    sara = (await pm.post(`/api/directory/${gypsum}/contacts`, { name: 'Sara Khan', position: 'Estimator', mobile: '66778899', is_primary: true })).body.id;
    const cs = await q('SELECT name, is_primary FROM directory_contacts WHERE entry_id = $1 ORDER BY name', [gypsum]);
    expect(cs).toEqual([{ name: 'Ali Hassan', is_primary: false }, { name: 'Sara Khan', is_primary: true }]);
    expect((await q(`SELECT count(*)::int n FROM users WHERE name IN ('Ali Hassan','Sara Khan')`))[0].n).toBe(0);
    expect((await viewer.post(`/api/directory/${gypsum}/contacts`, { name: 'x' })).status).toBe(403);
    // only an admin edits shared contact details
    expect((await pm.patch(`/api/directory/contacts/${ali}`, { position: 'x' })).status).toBe(403);
    expect((await admin.patch(`/api/directory/contacts/${ali}`, { position: 'Senior Project Engineer' })).body.position).toBe('Senior Project Engineer');
  });

  it('one company assigned to two projects; PMs assign only on their own projects', async () => {
    const a1 = await pm.post(`/api/directory/${gypsum}/assignments`, { project_id: P1, roles: ['finishing_contractor'], scope: 'Gypsum ceilings, ground floor', responsible_contact_id: ali, start_date: '2026-10-01' });
    expect(a1.status).toBe(201);
    expect((await pm.post(`/api/directory/${gypsum}/assignments`, { project_id: P2, roles: ['subcontractor'] })).status).toBe(400); // not pm's project
    expect((await pm.post(`/api/directory/${gypsum}/assignments`, { project_id: P1, roles: ['other'] })).status).toBe(409); // already assigned
    const a2 = await pm2.post(`/api/directory/${gypsum}/assignments`, { project_id: P2, roles: ['subcontractor'], scope: 'Painting works — P2 only' });
    expect(a2.status).toBe(201);
    expect((await pm.post(`/api/directory/${gypsum}/assignments`, { project_id: P1, roles: ['other'], start_date: '2026-10-05', end_date: '2026-10-01' })).status).toBe(400);
    expect((await pm.patch(`/api/directory/assignments/${a1.body.id}`, { start_date: '2026-10-05', end_date: '2026-10-01' })).status).toBe(400);
    expect((await pm.patch(`/api/directory/assignments/${a2.body.id}`, { scope: 'hijack' })).status).toBe(404);
    expect((await pm.post(`/api/directory/${solo}/assignments`, { project_id: P1, roles: ['consultant'], responsible_contact_id: ali })).status).toBe(400); // contact of another entry
    expect((await pm.post(`/api/directory/${solo}/assignments`, { project_id: P1, roles: ['consultant'] })).status).toBe(201);
  });

  it('never shows another project: list, details, search and project filter', async () => {
    const list = (await pm.get('/api/directory')).body;
    const g = list.entries.find((e: any) => e.id === gypsum);
    expect(g.assignments.map((a: any) => a.project_id)).toEqual([P1]);
    expect(JSON.stringify(list)).not.toContain('Painting works — P2 only');
    expect(list.projects.map((p: any) => p.id)).toEqual([P1]);
    const d = (await pm.get(`/api/directory/${gypsum}`)).body;
    expect(d.assignments.map((a: any) => a.project_id)).toEqual([P1]);
    expect(JSON.stringify(d)).not.toContain(P2);
    expect((await pm.get(`/api/directory?project=${P2}`)).body.entries).toEqual([]);
    const adm = await admin.get(`/api/directory/${gypsum}`);
    const all = adm.body.assignments.map((a: any) => a.project_id).sort();
    expect(all).toEqual([P1, P2].sort());
    // viewers see only entries assigned to their projects; contractors / consultants / outsiders get nothing
    const unassigned = (await admin.post('/api/directory', { display_name: 'Unassigned Supplies', entity_type: 'company', roles: ['supplier'] })).body.id;
    const v = (await viewer.get('/api/directory')).body.entries.map((e: any) => e.id);
    expect(v).toContain(gypsum);
    expect(v).not.toContain(unassigned);
    expect((await viewer.get(`/api/directory/${unassigned}`)).status).toBe(404);
    expect((await outsider.get('/api/directory')).body.entries).toEqual([]);
    for (const a of [contractor, consultant]) {
      expect((await a.get('/api/directory')).status).toBe(403);
      expect((await a.get(`/api/directory/${gypsum}`)).status).toBe(403);
      expect((await a.get(`/api/projects/${P1}/directory`)).status).toBe(403);
    }
    // search by phone (any format), contact name, email and reference
    for (const s of ['5512 3456', '+97455123456', 'sara', 'ali@gulfgypsum', gypsumRef.toLowerCase(), 'CR-123']) {
      expect((await pm.get(`/api/directory?q=${encodeURIComponent(s)}`)).body.entries.map((e: any) => e.id)).toContain(gypsum);
    }
    expect((await pm.get('/api/directory?role=consultant')).body.entries.map((e: any) => e.id)).toEqual([solo]);
    expect((await pm.get('/api/directory?spec=Gypsum')).body.entries.map((e: any) => e.id)).toEqual([gypsum]);
  });

  it('duplicate warnings never reveal entries the user cannot open', async () => {
    const m = (await pm.post('/api/directory/check-duplicates', { display_name: 'Gulf Gypsum', phone: '+974 4400 1122' })).body;
    expect(m.matches[0]).toMatchObject({ id: gypsum, reasons: ['Similar name', 'Same phone number'] });
    expect(m.hiddenMatch).toBeNull();
    const hidden = (await admin.post('/api/directory', { display_name: 'Secret Marble Co', entity_type: 'company', roles: ['supplier'], phone: '33445566' })).body.id;
    await admin.post(`/api/directory/${hidden}/archive`);
    const h = (await pm.post('/api/directory/check-duplicates', { display_name: 'Secret Marble', phone: '3344 5566' })).body;
    expect(h.matches).toEqual([]);
    expect(h.hiddenMatch).toMatch(/Ask an administrator/);
    expect(JSON.stringify(h)).not.toContain('Secret Marble Co');
    expect((await admin.post('/api/directory/check-duplicates', { phone: '33445566' })).body.matches[0]).toMatchObject({ id: hidden, archived: true });
    expect((await viewer.post('/api/directory/check-duplicates', { phone: '33445566' })).status).toBe(403);
    // a warning never blocks an authorised user
    expect((await pm.post('/api/directory', { display_name: 'Gulf Gypsum (Doha branch)', entity_type: 'company', roles: ['finishing_contractor'], phone: '44001122' })).status).toBe(201);
  });

  it('linking a record keeps amounts and the recorded name; only assigned, active entries; contact must belong', async () => {
    const m = (await pm.post(`/api/projects/${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Gulf Gypsum Est.', description: 'Ceiling advance', scheduled_amount: 25000 })).body;
    await pm.post(`/api/projects/${P1}/payments/milestones/${m.id}/transactions`, { amount: 10000, paid_date: '2026-09-15', method: 'bank_transfer', reference: 'GG-1' });
    const unassigned = (await admin.post('/api/directory', { display_name: 'Not Here Ltd', entity_type: 'company', roles: ['supplier'] })).body.id;
    expect((await pm.patch(`/api/projects/${P1}/payments/milestones/${m.id}`, { directory_entry_id: unassigned })).body.error).toMatch(/not assigned to this project/);
    expect((await pm.patch(`/api/projects/${P1}/payments/milestones/${m.id}`, { directory_entry_id: solo, directory_contact_id: ali })).body.error).toMatch(/does not belong/);
    const linked = (await pm.patch(`/api/projects/${P1}/payments/milestones/${m.id}`, { directory_entry_id: gypsum, directory_contact_id: ali })).body;
    expect(linked).toMatchObject({ payee_name: 'Gulf Gypsum Est.', scheduled_amount: 25000, directory_entry_id: gypsum, directory_contact_id: ali });
    const pay = (await pm.get(`/api/projects/${P1}/payments`)).body.milestones.find((x: any) => x.id === m.id);
    expect(pay).toMatchObject({ directory_entry_name: 'Gulf Gypsum Contracting WLL', directory_contact_name: 'Ali Hassan', balance: { paid: 10000, pending: 15000 } });
    expect((await q('SELECT count(*)::int n FROM payment_milestones'))[0].n).toBeGreaterThan(0);
    // changing the company drops a contact of the previous company; unlinking is allowed
    const sw = (await pm.patch(`/api/projects/${P1}/payments/milestones/${m.id}`, { directory_entry_id: solo })).body;
    expect(sw).toMatchObject({ directory_entry_id: solo, directory_contact_id: null, payee_name: 'Gulf Gypsum Est.' });
    await pm.patch(`/api/projects/${P1}/payments/milestones/${m.id}`, { directory_entry_id: gypsum, directory_contact_id: ali });
    // contractors cannot change links on material lines; consultants cannot on their visits
    const mat = (await admin.get(`/api/projects/${P1}/materials`)).body.items[0];
    await admin.patch(`/api/projects/${P1}/materials/${mat.id}`, { assigned_contractor_id: ctx.users.contractor });
    expect((await contractor.patch(`/api/projects/${P1}/materials/${mat.id}`, { directory_entry_id: gypsum })).status).toBe(403);
    const cv = (await consultant.post(`/api/projects/${P1}/visits/consultant`, { purpose: 'Check', directory_entry_id: solo })).status;
    expect(cv).toBe(403);
    // the audit records the link change
    const a = (await pm.get(`/api/projects/${P1}/audit`)).body.find((x: any) => x.entity_id === m.id && x.after?.directory_entry_id === gypsum);
    expect(a).toBeTruthy();
  });

  it('suggestions are shown for review only; linking one record changes nothing else', async () => {
    const k = (await pm.post(`/api/projects/${P1}/contracts`, { title: 'Gypsum works', category_id: (await pm.get(`/api/projects/${P1}/categories`)).body.contract[0].id, company_name: 'GULF GYPSUM contracting', contract_value: 90000 })).body;
    const before = (await q('SELECT * FROM contracts WHERE id = $1', [k.id]))[0];
    const s = (await pm.get(`/api/directory/${gypsum}/suggestions`)).body.suggestions;
    const hit = s.find((x: any) => x.id === k.id);
    expect(hit).toMatchObject({ type: 'contract', original_name: 'GULF GYPSUM contracting', assigned: true });
    expect((await q('SELECT directory_entry_id FROM contracts WHERE id = $1', [k.id]))[0].directory_entry_id).toBeNull(); // not linked automatically
    expect((await viewer.get(`/api/directory/${gypsum}/suggestions`)).status).toBe(403);
    expect((await pm.post(`/api/directory/${gypsum}/link`, { type: 'contract', record_id: k.id })).status).toBe(200);
    const after = (await q('SELECT * FROM contracts WHERE id = $1', [k.id]))[0];
    expect(after.directory_entry_id).toBe(gypsum);
    expect({ ...after, directory_entry_id: null, updated_at: null }).toEqual({ ...before, updated_at: null });
    expect((await pm.post(`/api/directory/${gypsum}/link`, { type: 'contract', record_id: k.id })).status).toBe(409);
    expect((await pm2.post(`/api/directory/${gypsum}/link`, { type: 'contract', record_id: k.id })).status).toBe(404); // other project's record
    const log = (await pm.get(`/api/projects/${P1}/audit`)).body.find((x: any) => x.action === 'directory_link' && x.entity_id === k.id);
    expect(log.summary).toMatch(/recorded name "GULF GYPSUM contracting", unchanged/);
  });

  it('related records show only authorised projects, without financial values for users lacking them', async () => {
    const d = (await pm.get(`/api/directory/${gypsum}`)).body;
    expect(d.related.contract).toHaveLength(1);
    expect(d.related.payment_milestone[0]).toMatchObject({ paid: 10000, transfer_count: 1 });
    expect(d.related.contract[0].contract_value).toBe(90000);
    const p2view = (await pm2.get(`/api/directory/${gypsum}`)).body;
    expect(p2view.related.contract ?? []).toEqual([]);
    expect(p2view.related.payment_milestone ?? []).toEqual([]);
    expect(JSON.stringify(p2view)).not.toContain('Gulf Gypsum Est.');
  });

  it('documents: shared vs project-specific, with scoped download', async () => {
    expect((await pm.upload(`/api/directory/${gypsum}/documents`, { kind: 'company_profile', visibility: 'shared' }, { buf: PDF, name: 'profile.pdf' })).status).toBe(403);
    const shared = (await admin.upload(`/api/directory/${gypsum}/documents`, { kind: 'company_profile', visibility: 'shared' }, { buf: PDF, name: 'profile.pdf' })).body;
    const proj = (await pm.upload(`/api/directory/${gypsum}/documents`, { kind: 'quotation', visibility: P1 }, { buf: PDF, name: 'p1-quote.pdf' })).body;
    expect(shared.project_id).toBeNull();
    expect(proj.project_id).toBe(P1);
    expect((await pm.upload(`/api/directory/${gypsum}/documents`, { kind: 'quotation', visibility: P2 }, { buf: PDF, name: 'x.pdf' })).status).toBe(400);
    expect((await pm.upload(`/api/directory/${gypsum}/documents`, { kind: 'quotation', visibility: P1 }, { buf: Buffer.from('<html>'), name: 'x.pdf' })).status).toBe(415);
    const dl = (a: Agent, id: string) => a.get(`/api/directory/${gypsum}/documents/${id}/download`);
    expect((await dl(viewer, proj.id)).status).toBe(200);
    expect((await dl(pm2, shared.id)).status).toBe(200);
    expect((await dl(pm2, proj.id)).status).toBe(404); // another project's document
    expect((await pm2.get(`/api/directory/${gypsum}`)).body.documents.map((x: any) => x.id)).toEqual([shared.id]);
    expect((await dl(contractor, shared.id)).status).toBe(403);
    expect((await request(ctx.app).get(`/api/directory/${gypsum}/documents/${shared.id}/download`)).status).toBe(401);
    const inline = await viewer.get(`/api/directory/${gypsum}/documents/${shared.id}/download?inline=1`);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    expect(inline.headers['cache-control']).toContain('no-store');
    // the project attachments routes never serve directory documents
    expect((await pm.get(`/api/projects/${P1}/attachments/${proj.id}/download`)).status).toBe(404);
    expect((await pm.post(`/api/projects/${P1}/attachments/${proj.id}/archive`)).status).toBe(404);
    expect((await pm2.post(`/api/directory/${gypsum}/documents/${proj.id}/archive`)).status).toBe(404);
    expect((await pm.post(`/api/directory/${gypsum}/documents/${shared.id}/archive`)).status).toBe(403);
  });

  it('renaming and archiving never rewrite historical names or break existing links', async () => {
    expect((await pm.patch(`/api/directory/${gypsum}`, { display_name: 'x' })).status).toBe(403);
    expect((await admin.patch(`/api/directory/${gypsum}`, { display_name: 'Gulf Gypsum & Decor WLL' })).status).toBe(200);
    const pay = (await pm.get(`/api/projects/${P1}/payments`)).body.milestones.find((x: any) => x.directory_entry_id === gypsum);
    expect(pay).toMatchObject({ payee_name: 'Gulf Gypsum Est.', directory_entry_name: 'Gulf Gypsum & Decor WLL' });
    expect((await q('SELECT company_name FROM contracts WHERE directory_entry_id = $1', [gypsum]))[0].company_name).toBe('GULF GYPSUM contracting');
    await admin.post(`/api/directory/contacts/${ali}/archive`);
    await admin.post(`/api/directory/${gypsum}/archive`);
    const again = (await pm.get(`/api/projects/${P1}/payments`)).body.milestones.find((x: any) => x.id === pay.id);
    expect(again).toMatchObject({ directory_entry_id: gypsum, directory_contact_id: ali, directory_contact_name: 'Ali Hassan' });
    expect(again.directory_entry_archived_at).toBeTruthy();
    // archived entries are not offered for new selections, but existing links stay valid on edit
    expect((await pm.get(`/api/projects/${P1}/directory`)).body.map((e: any) => e.id)).not.toContain(gypsum);
    expect((await pm.patch(`/api/projects/${P1}/payments/milestones/${pay.id}`, { notes: 'still linked' })).body.directory_entry_id).toBe(gypsum);
    const m2 = (await pm.post(`/api/projects/${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'New', description: 'x', scheduled_amount: 1, directory_entry_id: gypsum })).body;
    expect(m2.error).toMatch(/archived/);
    // archived entries remain readable to the project that uses them
    expect((await pm.get(`/api/directory/${gypsum}`)).status).toBe(200);
    expect((await pm.get('/api/directory?status=archived')).body.entries.map((e: any) => e.id)).toContain(gypsum);
    expect((await pm.post(`/api/directory/${gypsum}/contacts`, { name: 'x' })).status).toBe(409);
    await admin.post(`/api/directory/${gypsum}/restore`);
  });

  it('project selector lists only active entries assigned to that project, with active contacts', async () => {
    const p1 = (await viewer.get(`/api/projects/${P1}/directory`)).body;
    const g = p1.find((e: any) => e.id === gypsum);
    expect(g.contacts.map((c: any) => c.name)).toEqual(['Sara Khan']); // Ali was archived
    expect(g.roles).toEqual(['finishing_contractor']);
    expect((await pm.get(`/api/projects/${P2}/directory`)).status).toBe(404);
    expect((await pm2.get(`/api/projects/${P2}/directory`)).body.find((e: any) => e.id === gypsum).roles).toEqual(['subcontractor']);
  });
});
