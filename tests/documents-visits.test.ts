// Update 12: central project documents + prerequisite evidence, budget item attachments, consultant
// visit workflow, contacts with several people / assignments, and Arabic / mixed-language file names.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDF, PNG, setup, type Agent, type Ctx } from './helpers';
import { readableSourceTypes } from '../server/routes/documents';
import { effectiveFileName, sanitizeFileName, suggestRepairedName } from '../shared/filenames';
import { contentDisposition } from '../server/routes/attachments';
import { BackupStore } from '../server/backup/store';
import { createBackup } from '../server/backup/create';
import { readMigrations } from '../server/lib/migrate';

let ctx: Ctx;
let admin: Agent, pm: Agent, pm2: Agent, viewer: Agent, contractor: Agent, consultant: Agent;
let P1: string, P2: string;
const AR = 'رخصة البناء 2026 (نهائي).pdf';
const MIXED = 'Survey تقرير المساحة - v2, final.pdf';

beforeAll(async () => {
  ctx = await setup();
  [admin, pm, pm2, viewer, contractor, consultant] = await Promise.all(['admin', 'pm', 'pm2', 'viewer', 'contractor', 'consultant'].map((r) => ctx.agent(r)));
  P1 = `/api/projects/${ctx.projects.p1}`;
  P2 = `/api/projects/${ctx.projects.p2}`;
});
afterAll(async () => { await ctx.close(); });

const q = async (sql: string, args: unknown[] = []) => (await ctx.pool.query(sql, args)).rows;

describe('file names (Arabic, English, mixed)', () => {
  it('sanitising keeps Arabic letters and strips paths, controls and bidi overrides', () => {
    expect(sanitizeFileName(AR)).toBe(AR);
    expect(sanitizeFileName(MIXED)).toBe(MIXED);
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\fakepath\\تقرير.pdf')).toBe('تقرير.pdf');
    expect(sanitizeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFileName('<script>x</script>.pdf')).not.toMatch(/[<>/]/);
    expect(sanitizeFileName('')).toBe('file');
    expect(effectiveFileName({ original_name: 'a.pdf', display_name: 'تقرير نهائي' })).toBe('تقرير نهائي.pdf');
    expect(effectiveFileName({ original_name: 'a.pdf', display_name: null })).toBe('a.pdf');
    const mojibake = Buffer.from(AR, 'utf8').toString('latin1');
    expect(suggestRepairedName(mojibake)).toBe(AR);
    expect(suggestRepairedName(AR)).toBeNull();
    expect(suggestRepairedName('Café menu.pdf')).toBeNull();
    const cd = contentDisposition('attachment', AR);
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(AR).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    expect(cd).toMatch(/filename="[\x20-\x7e]+"/);
  });

  it('upload keeps the exact Unicode name; preview / download send it; rename changes only the display name', async () => {
    const m = await pm.post(`${P1}/payments/milestones`, { payee_type: 'consultant', payee_name: 'Consultant', description: 'Fee', scheduled_amount: 1000 });
    const up = await pm.upload(`${P1}/attachments`, { entity_type: 'payment_milestone', entity_id: m.body.id, kind: 'supporting_document' }, { buf: PDF, name: AR });
    expect(up.status).toBe(201);
    expect(up.body.original_name).toBe(AR);
    const row = (await q('SELECT stored_name, original_name FROM attachments WHERE id = $1', [up.body.id]))[0];
    expect(row.original_name).toBe(AR);
    expect(row.stored_name).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    const list = await pm.get(`${P1}/attachments?entity_type=payment_milestone&entity_id=${m.body.id}`);
    expect(list.body[0].name).toBe(AR);
    for (const inline of ['', '?inline=1']) {
      const dl = await pm.get(`${P1}/attachments/${up.body.id}/download${inline}`);
      expect(dl.status).toBe(200);
      expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(dl.headers['content-disposition'])![1])).toBe(AR);
    }
    const mixed = await pm.upload(`${P1}/attachments`, { entity_type: 'payment_milestone', entity_id: m.body.id, kind: 'supporting_document' }, { buf: PDF, name: MIXED });
    expect(mixed.body.original_name).toBe(MIXED);
    // rename display name (file, id and links unchanged)
    const r = await pm.patch(`${P1}/attachments/${up.body.id}`, { display_name: 'تصريح البلدية', description: 'Final permit' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('تصريح البلدية.pdf');
    const after = (await q('SELECT stored_name, original_name, display_name, description FROM attachments WHERE id = $1', [up.body.id]))[0];
    expect(after).toMatchObject({ stored_name: row.stored_name, original_name: AR, display_name: 'تصريح البلدية', description: 'Final permit' });
    const dl = await pm.get(`${P1}/attachments/${up.body.id}/download`);
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(dl.headers['content-disposition'])![1])).toBe('تصريح البلدية.pdf');
    expect((await viewer.patch(`${P1}/attachments/${up.body.id}`, { display_name: 'x' })).status).toBe(403);
    expect((await pm2.patch(`/api/projects/${ctx.projects.p2}/attachments/${up.body.id}`, { display_name: 'x' })).status).toBe(404);
    // an existing corrupted name gets a repair suggestion, never an automatic change
    const bad = Buffer.from(AR, 'utf8').toString('latin1');
    await ctx.pool.query('UPDATE attachments SET original_name = $2 WHERE id = $1', [mixed.body.id, bad]);
    const l2 = await pm.get(`${P1}/attachments?entity_type=payment_milestone&entity_id=${m.body.id}`);
    const it = l2.body.find((a: { id: string }) => a.id === mixed.body.id);
    expect(it.original_name).toBe(bad);
    expect(it.suggested_name).toBe(AR);
  });
});

describe('project documents and prerequisites', () => {
  let docId = '';
  let preId = '';
  it('only roles with document access can use the register; other projects are invisible', async () => {
    expect((await contractor.get(`${P1}/documents`)).status).toBe(403);
    expect((await consultant.get(`${P1}/documents`)).status).toBe(403);
    expect((await pm2.get(`${P1}/documents`)).status).toBe(404);
    expect(readableSourceTypes('contractor')).not.toContain('payment_transaction');
    expect(readableSourceTypes('project_manager')).toEqual(expect.arrayContaining(['project_document', 'payment_transaction', 'budget_item']));
  });

  it('a project document holds its own files; the register lists files from other modules with their source', async () => {
    const d = await pm.post(`${P1}/documents`, { title: 'Building permit', category: 'permit', reference: 'BP-77', document_date: '2026-09-01' });
    expect(d.status).toBe(201);
    docId = d.body.id;
    expect((await viewer.post(`${P1}/documents`, { title: 'x' })).status).toBe(403);
    expect((await pm.upload(`${P1}/attachments`, { entity_type: 'project_document', entity_id: docId, kind: 'permit' }, { buf: PDF, name: AR })).status).toBe(201);
    expect((await pm.upload(`${P1}/attachments`, { entity_type: 'project_document', entity_id: docId, kind: 'quotation' }, { buf: PDF, name: 'q.pdf' })).status).toBe(400);
    const reg = await viewer.get(`${P1}/documents`);
    expect(reg.status).toBe(200);
    expect(reg.body.documents.find((x: { id: string }) => x.id === docId)).toMatchObject({ title: 'Building permit', file_count: 1 });
    const own = reg.body.register.find((x: { entity_type: string }) => x.entity_type === 'project_document');
    expect(own).toMatchObject({ source_title: 'Building permit', name: AR, href: `#/contracts/${ctx.projects.p1}/${docId}` });
    const slip = reg.body.register.find((x: { entity_type: string }) => x.entity_type === 'payment_milestone');
    expect(slip.href).toMatch(new RegExp(`^#/payments/${ctx.projects.p1}/`));
    expect((await pm2.get(`${P2}/documents`)).body.register.some((x: { id: string }) => x.id === own.id)).toBe(false);
  });

  it('upload against a prerequisite creates one register document; linking never changes the status', async () => {
    preId = (await pm.post(`${P1}/prerequisites`, { title: 'Municipality approval' })).body.id;
    const u = await pm.upload(`${P1}/prerequisites/${preId}/upload`, { category: 'approval' }, { buf: PDF, name: MIXED });
    expect(u.status).toBe(201);
    expect(u.body.status).toBe('Not started');
    expect(u.body.documents).toHaveLength(1);
    expect(u.body.documents[0]).toMatchObject({ category: 'approval', file_count: 1, title: MIXED.replace(/\.pdf$/, '') });
    const newDoc = u.body.documents[0].id;
    const files = await q(`SELECT count(*)::int n FROM attachments WHERE entity_type = 'project_document' AND entity_id = $1`, [newDoc]);
    expect(files[0].n).toBe(1);
    expect((await q(`SELECT count(*)::int n FROM attachments WHERE entity_type = 'prerequisite' AND entity_id = $1`, [preId]))[0].n).toBe(0);
    // link an existing register document; idempotent
    const l = await pm.post(`${P1}/prerequisites/${preId}/documents`, { document_id: docId });
    expect(l.body.documents.map((x: { id: string }) => x.id)).toEqual([newDoc, docId]);
    expect((await pm.post(`${P1}/prerequisites/${preId}/documents`, { document_id: docId })).body.documents).toHaveLength(2);
    expect(l.body.status).toBe('Not started');
    // documents show which prerequisites they support
    const reg = await pm.get(`${P1}/documents`);
    expect(reg.body.documents.find((x: { id: string }) => x.id === docId).prerequisites).toEqual([{ id: preId, title: 'Municipality approval', status: 'Not started' }]);
    // other project / roles
    expect((await pm2.post(`${P2}/prerequisites/${preId}/documents`, { document_id: docId })).status).toBe(404);
    expect((await viewer.post(`${P1}/prerequisites/${preId}/documents`, { document_id: docId })).status).toBe(403);
    const otherDoc = (await pm2.post(`${P2}/documents`, { title: 'P2 doc' })).body.id;
    expect((await pm.post(`${P1}/prerequisites/${preId}/documents`, { document_id: otherDoc })).status).toBe(404);
    // unlink keeps the document and its files
    const un = await pm.post(`${P1}/prerequisites/${preId}/documents/${docId}/unlink`);
    expect(un.body.documents).toHaveLength(1);
    expect((await q('SELECT count(*)::int n FROM project_documents WHERE id = $1', [docId]))[0].n).toBe(1);
    // explicit status change is still the only way to complete
    expect((await pm.patch(`${P1}/prerequisites/${preId}`, { status: 'Completed' })).body.status).toBe('Completed');
  });

  it('legacy prerequisite files stay attached and appear in the register with their source', async () => {
    const legacy = await pm.upload(`${P1}/attachments`, { entity_type: 'prerequisite', entity_id: preId, kind: 'supporting_document' }, { buf: PDF, name: 'old survey.pdf' });
    expect(legacy.status).toBe(201);
    const reg = await pm.get(`${P1}/documents`);
    expect(reg.body.register.find((x: { id: string }) => x.id === legacy.body.id)).toMatchObject({ entity_type: 'prerequisite', source_title: 'Municipality approval', href: `#/dashboard/${ctx.projects.p1}/${preId}` });
  });
});

describe('budget item attachments', () => {
  it('fixed and finishing items accept files; amounts and payments never change; only its own files are listed', async () => {
    const b0 = (await admin.get(`${P1}/budget`)).body;
    const cats = new Map(b0.categories.map((c: { id: string; kind: string }) => [c.id, c.kind]));
    const fixed = b0.items.find((i: { category_id: string }) => cats.get(i.category_id) === 'fixed');
    const fin = b0.items.find((i: { category_id: string }) => cats.get(i.category_id) === 'finishing');
    for (const item of [fixed, fin]) {
      const u = await admin.upload(`${P1}/attachments`, { entity_type: 'budget_item', entity_id: item.id, kind: 'quotation', description: 'Supplier quote' }, { buf: PDF, name: 'عرض سعر.pdf' });
      expect(u.status).toBe(201);
      expect(u.body.description).toBe('Supplier quote');
    }
    expect((await pm.upload(`${P1}/attachments`, { entity_type: 'budget_item', entity_id: fixed.id, kind: 'invoice' }, { buf: PDF, name: 'i.pdf' })).status).toBe(403);
    expect((await admin.upload(`${P1}/attachments`, { entity_type: 'budget_item', entity_id: fixed.id, kind: 'payment_slip' }, { buf: PDF, name: 'i.pdf' })).status).toBe(400);
    const b1 = (await admin.get(`${P1}/budget`)).body;
    expect(b1.summary).toEqual(b0.summary);
    expect(b1.items.find((i: { id: string }) => i.id === fixed.id).attachment_count).toBe(1);
    expect(b1.items.find((i: { id: string }) => i.id === fin.id).approved_amount).toBe(fin.approved_amount);
    // viewer reads, can list files
    expect((await viewer.get(`${P1}/attachments?entity_type=budget_item&entity_id=${fixed.id}`)).body).toHaveLength(1);
    expect((await contractor.get(`${P1}/attachments?entity_type=budget_item&entity_id=${fixed.id}`)).status).toBe(403);
    // drive link on the item
    expect((await admin.patch(`${P1}/budget/items/${fixed.id}`, { drive_url: 'https://drive.google.com/drive/folders/abc' })).body.drive_url).toBe('https://drive.google.com/drive/folders/abc');
    // the related-documents list was removed (Update 13): the item's window only lists its own files
    expect((await viewer.get(`${P1}/budget/items/${fixed.id}/related`)).status).toBe(404);
    const before = await q('SELECT count(*)::int n FROM attachments');
    expect(before[0].n).toBeGreaterThan(0);
  });
});

describe('consultant visit workflow', () => {
  let visitId = '';
  it('schedule with a directory consultant and contact; reschedule, complete without report, upload report', async () => {
    const e = (await admin.post('/api/directory', { display_name: 'Arab Engineering Bureau', entity_type: 'company', roles: ['consultant'],
      contacts: [{ name: 'Eng. Omar', mobile: '5511 2233', whatsapp: '6677 8899', email: 'omar@aeb.qa', is_primary: true }, { name: 'Lina', position: 'Architect' }] })).body;
    expect(e.id).toBeTruthy();
    const contacts = await q('SELECT name, is_primary, whatsapp_normalized FROM directory_contacts WHERE entry_id = $1 ORDER BY name', [e.id]);
    expect(contacts).toEqual([{ name: 'Eng. Omar', is_primary: true, whatsapp_normalized: '97466778899' }, { name: 'Lina', is_primary: false, whatsapp_normalized: '' }]);
    const omar = (await q(`SELECT id FROM directory_contacts WHERE name = 'Eng. Omar'`))[0].id;
    await pm.post(`/api/directory/${e.id}/assignments`, { project_id: ctx.projects.p1, roles: ['consultant'], responsible_contact_id: omar });
    const planned = new Date(Date.now() + 3 * 86400_000).toISOString();
    const v = await pm.post(`${P1}/visits/consultant`, { purpose: 'Slab inspection', planned_at: planned, directory_entry_id: e.id, directory_contact_id: omar, assigned_user_id: ctx.users.pm, consultant_name: 'AEB' });
    expect(v.status).toBe(201);
    visitId = v.body.id;
    let row = (await pm.get(`${P1}/visits/consultant`)).body.find((x: { id: string }) => x.id === visitId);
    expect(row).toMatchObject({ visit_state: 'Scheduled', report_status: 'Report pending', directory_contact_name: 'Eng. Omar', directory_contact_whatsapp: '6677 8899', assigned_user_name: 'pm' });
    // consultant role: no directory contact details or payment details
    const cRow = (await consultant.get(`${P1}/visits/consultant`)).body.find((x: { id: string }) => x.id === visitId);
    expect(cRow.directory_contact_mobile).toBeUndefined();
    // reschedule (audited; old time kept in history)
    const newTime = new Date(Date.now() + 5 * 86400_000).toISOString();
    const rs = await pm.post(`${P1}/visits/consultant/${visitId}/reschedule`, { planned_at: newTime, reason: 'Consultant unavailable' });
    expect(rs.body.status).toBe('Rescheduled');
    // uploading a report while scheduled does not complete the visit
    expect((await pm.upload(`${P1}/attachments`, { entity_type: 'consultant_visit', entity_id: visitId, kind: 'consultant_report' }, { buf: PDF, name: 'تقرير الزيارة.pdf' })).status).toBe(201);
    row = (await pm.get(`${P1}/visits/consultant`)).body.find((x: { id: string }) => x.id === visitId);
    expect(row).toMatchObject({ status: 'Rescheduled', visit_state: 'Scheduled', report_status: 'Report uploaded' });
    // complete with an actual date different from the plan
    const actual = new Date(Date.now() - 3600_000).toISOString();
    const done = await pm.post(`${P1}/visits/consultant/${visitId}/complete`, { actual_visit_at: actual });
    expect(done.body.status).toBe('Completed');
    expect(new Date(done.body.actual_visit_at).toISOString()).toBe(actual);
    expect((await pm.post(`${P1}/visits/consultant/${visitId}/complete`, { actual_visit_at: new Date(Date.now() + 86400_000).toISOString() })).status).toBe(400);
    expect((await pm.post(`${P1}/visits/consultant/${visitId}/cancel`, {})).status).toBe(400);
    expect((await pm.post(`${P1}/visits/consultant/${visitId}/reschedule`, { planned_at: newTime })).status).toBe(400);
    const hist = (await pm.get(`${P1}/visits/consultant/${visitId}/history`)).body.map((h: { summary: string }) => h.summary).join(' | ');
    expect(hist).toMatch(/Rescheduled consultant visit .*Consultant unavailable/);
    expect(hist).toMatch(/completed/);
  });

  it('a completed visit can still be awaiting its report; cancel keeps the record', async () => {
    const v = (await pm.post(`${P1}/visits/consultant`, { purpose: 'MEP check', planned_at: new Date(Date.now() - 86400_000).toISOString() })).body;
    await pm.post(`${P1}/visits/consultant/${v.id}/complete`, {});
    const row = (await pm.get(`${P1}/visits/consultant`)).body.find((x: { id: string }) => x.id === v.id);
    expect(row).toMatchObject({ visit_state: 'Completed', report_status: 'Report pending' });
    const dash = (await pm.get(`${P1}/dashboard`)).body;
    expect(dash.consultantReportsMissing.map((x: { id: string }) => x.id)).toContain(v.id);
    const c = (await pm.post(`${P1}/visits/consultant`, { purpose: 'Cancelled one' })).body;
    const cancelled = await pm.post(`${P1}/visits/consultant/${c.id}/cancel`, { reason: 'Scope changed' });
    expect(cancelled.body).toMatchObject({ status: 'Cancelled', cancel_reason: 'Scope changed' });
    expect((await viewer.post(`${P1}/visits/consultant/${c.id}/cancel`, {})).status).toBe(403);
    expect((await pm2.post(`${P2}/visits/consultant/${c.id}/cancel`, {})).status).toBe(404);
  });

  it('next 14 days shows planned and completed visits once each, labelled distinctly', async () => {
    const planned = (await pm.post(`${P1}/visits/consultant`, { purpose: 'Upcoming slab inspection', planned_at: new Date(Date.now() + 2 * 86400_000).toISOString() })).body;
    const doneToday = (await pm.post(`${P1}/visits/consultant`, { purpose: 'Done today inspection', planned_at: new Date(Date.now() + 3 * 86400_000).toISOString() })).body;
    await pm.post(`${P1}/visits/consultant/${doneToday.id}/complete`, { actual_visit_at: new Date(Date.now() - 60_000).toISOString() });
    const up = (await pm.get(`${P1}/dashboard`)).body.upcoming as Array<{ id: string; dateLabel: string }>;
    expect(up.filter((x) => x.id === planned.id)).toEqual([expect.objectContaining({ dateLabel: 'Consultant visit / inspection · planned' })]);
    expect(up.filter((x) => x.id === doneToday.id)).toEqual([expect.objectContaining({ dateLabel: 'Consultant visit · completed' })]);
    const cancelled = (await pm.post(`${P1}/visits/consultant`, { purpose: 'Will cancel', planned_at: new Date(Date.now() + 86400_000).toISOString() })).body;
    await pm.post(`${P1}/visits/consultant/${cancelled.id}/cancel`, {});
    expect(((await pm.get(`${P1}/dashboard`)).body.upcoming as Array<{ id: string }>).some((x) => x.id === cancelled.id)).toBe(false);
  });

  it('comments with author and time; follow-up actions with a responsible user', async () => {
    const c1 = await pm.post(`${P1}/visits/consultant/${visitId}/comments`, { body: 'Report received by email; uploaded.' });
    expect(c1.status).toBe(201);
    const list = await viewer.get(`${P1}/visits/consultant/${visitId}/comments`);
    expect(list.body).toEqual([expect.objectContaining({ body: 'Report received by email; uploaded.', author_name: 'pm' })]);
    expect((await viewer.post(`${P1}/visits/consultant/${visitId}/comments`, { body: 'x' })).status).toBe(403);
    const a = await pm.post(`${P1}/visits/consultant/${visitId}/actions`, { description: 'Fix rebar spacing', responsible: 'Contractor', responsible_user_id: ctx.users.contractor, due_date: '2026-11-01' });
    expect(a.status).toBe(201);
    expect((await pm.post(`${P1}/visits/consultant/${visitId}/actions`, { description: 'x', responsible_user_id: ctx.users.pm2 })).status).toBe(400);
    // consultants cannot attach payments
    expect((await consultant.post(`${P1}/visits/consultant`, { purpose: 'own', related_milestone_id: (await q('SELECT id FROM payment_milestones LIMIT 1'))[0].id })).status).toBe(403);
  });
});

describe('contacts: one company, several people, several projects', () => {
  it('each project can prefer a different person of the same company; people must belong to it', async () => {
    const e = (await admin.post('/api/directory', { display_name: 'Gulf Tiles Trading', entity_type: 'company', roles: ['supplier'],
      contacts: [{ name: 'Sales desk', mobile: '4444 1111' }, { name: 'Ravi', mobile: '5555 2222', is_primary: true }] })).body;
    const people = await q('SELECT id, name, is_primary FROM directory_contacts WHERE entry_id = $1 ORDER BY name', [e.id]);
    expect(people.map((p) => [p.name, p.is_primary])).toEqual([['Ravi', true], ['Sales desk', false]]);
    const [ravi, desk] = people;
    const a1 = await admin.post(`/api/directory/${e.id}/assignments`, { project_id: ctx.projects.p1, roles: ['supplier'], responsible_contact_id: ravi.id, scope: 'Floor tiles' });
    const a2 = await admin.post(`/api/directory/${e.id}/assignments`, { project_id: ctx.projects.p2, roles: ['supplier'], responsible_contact_id: desk.id, status: 'on_hold' });
    expect([a1.status, a2.status]).toEqual([201, 201]);
    expect(a2.body.status).toBe('on_hold');
    const other = (await admin.post('/api/directory', { display_name: 'Other Co', entity_type: 'company', roles: ['supplier'], contacts: [{ name: 'Someone' }] })).body;
    const someone = (await q('SELECT id FROM directory_contacts WHERE entry_id = $1', [other.id]))[0].id;
    expect((await admin.patch(`/api/directory/assignments/${a1.body.id}`, { responsible_contact_id: someone })).status).toBe(400);
    expect((await admin.post('/api/directory', { display_name: 'Two primaries', entity_type: 'company', roles: ['other'], contacts: [{ name: 'a', is_primary: true }, { name: 'b', is_primary: true }] })).status).toBe(400);
    // pm (project 1) sees only its own assignment; never project 2's name
    const d = await pm.get(`/api/directory/${e.id}`);
    expect(d.body.assignments.map((x: { project_id: string }) => x.project_id)).toEqual([ctx.projects.p1]);
    expect(JSON.stringify(d.body)).not.toContain('PIN 70153016');
    // no login is created
    expect((await q(`SELECT count(*)::int n FROM users WHERE name IN ('Ravi','Sales desk')`))[0].n).toBe(0);
  });
});

describe('backup includes the new records and files', () => {
  it('project documents, links, comments and budget item files are in the archive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-bk12-'));
    try {
      const store = new BackupStore(dir);
      const meta = await createBackup({ pool: ctx.pool, uploadDir: ctx.uploadDir, store, ops: null,
        app: { name: 't', version: 't', commit: '', migrations: readMigrations(path.resolve('migrations')) } }, { kind: 'manual', source: 'web', actor: null });
      expect(meta.status).toBe('verified');
      const counts = meta.summary!.counts;
      expect(counts.project_documents).toBeGreaterThan(0);
      expect(counts.prerequisite_documents).toBeGreaterThan(0);
      expect(counts.visit_comments).toBeGreaterThan(0);
      const files = Number((await q(`SELECT count(*)::int n FROM attachments WHERE project_id IS NOT NULL`))[0].n);
      expect(meta.attachments!.filesIncluded).toBe(files);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
