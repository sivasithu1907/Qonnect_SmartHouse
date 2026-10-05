// File View (inline preview) and Download responses: headers, scoped CSP, type checks, access rules and
// readable errors. All files here are isolated test fixtures in a temporary upload directory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { PDF, PNG, setup, type Agent, type Ctx } from './helpers';
import { contentDisposition, fileCsp } from '../server/routes/attachments';

let ctx: Ctx;
let P = '';
let pm: Agent;
let milestoneId = '';
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);

async function up(buf: Buffer, name: string, entity_type = 'payment_milestone', entity_id = milestoneId, kind = 'supporting_document') {
  const r = await pm.upload(P + '/attachments', { entity_type, entity_id, kind }, { buf, name });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const url = (id: string, inline = false, project = P) => `${project}/attachments/${id}/download${inline ? '?inline=1' : ''}`;

beforeAll(async () => {
  ctx = await setup();
  P = `/api/projects/${ctx.projects.p1}`;
  pm = await ctx.agent('pm');
  milestoneId = (await pm.post(P + '/payments/milestones', { payee_type: 'other', payee_name: 'Municipality', description: 'Permit', scheduled_amount: 1305 })).body.id;
});
afterAll(async () => { await ctx.close(); });

describe('PDF View and Download', () => {
  let pdfId = '';
  beforeAll(async () => { pdfId = await up(PDF, 'Payment_2.pdf'); });

  it('View returns the PDF bytes inline with application/pdf and a non-sandboxed, script-free policy', async () => {
    const r = await pm.get(url(pdfId, true)).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe(`inline; filename="Payment_2.pdf"; filename*=UTF-8''Payment_2.pdf`);
    expect(r.headers['content-length']).toBe(String(PDF.length));
    expect(Buffer.from(r.body).subarray(0, 5).toString()).toBe('%PDF-');
    const csp = r.headers['content-security-policy'];
    expect(csp).not.toMatch(/\bsandbox\b/);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/script-src|connect-src/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('private, no-store, max-age=0');
  });

  it('Download returns the same bytes as an attachment and stays fully sandboxed', async () => {
    const r = await pm.get(url(pdfId)).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="Payment_2.pdf"/);
    expect(r.headers['content-security-policy']).toMatch(/^sandbox;/);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(r.body).equals(PDF)).toBe(true);
  });
});

describe('other file types', () => {
  it('images still preview inline under the sandboxed policy', async () => {
    const id = await up(PNG, 'site.png');
    const r = await pm.get(url(id, true));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-disposition']).toMatch(/^inline;/);
    expect(r.headers['content-security-policy']).toMatch(/^sandbox;/);
  });

  it('unsupported preview types are always downloaded, even when View is requested', async () => {
    const id = await up(DOCX, 'Quote.docx');
    const r = await pm.get(url(id, true));
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers['content-security-policy']).toMatch(/^sandbox;/);
  });

  it('a stored file whose bytes no longer match its saved type is downloaded, not previewed', async () => {
    const id = await up(PDF, 'changed.pdf');
    const row = (await ctx.pool.query('SELECT stored_name FROM attachments WHERE id = $1', [id])).rows[0];
    fs.writeFileSync(path.join(ctx.uploadDir, ctx.projects.p1, row.stored_name), '<html><script>alert(1)</script></html>');
    const r = await pm.get(url(id, true));
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers['content-security-policy']).toMatch(/^sandbox;/);
    expect(r.headers['content-type']).toBe('application/pdf');
  });

  it('file names are encoded safely (ASCII fallback + exact UTF-8 name)', () => {
    expect(contentDisposition('inline', 'دفعة "1"; final%.pdf')).toBe(
      `inline; filename="____ _1__ final_.pdf"; filename*=UTF-8''%D8%AF%D9%81%D8%B9%D8%A9%20%221%22%3B%20final%25.pdf`);
    expect(contentDisposition('attachment', "a'(b)*\r\nc.pdf")).toBe(`attachment; filename="a'(b)*__c.pdf"; filename*=UTF-8''a%27%28b%29%2A%0D%0Ac.pdf`);
    expect(fileCsp('image/png', true)).toMatch(/^sandbox;/);
    expect(fileCsp('application/pdf', false)).toMatch(/^sandbox;/);
  });
});

describe('access and errors are unchanged for View and Download', () => {
  let pdfId = '';
  beforeAll(async () => { pdfId = await up(PDF, 'slip.pdf'); });

  it('role checks and project isolation apply to both paths', async () => {
    for (const inline of [false, true]) {
      expect((await (await ctx.agent('viewer')).get(url(pdfId, inline))).status).toBe(200);
      expect((await (await ctx.agent('contractor')).get(url(pdfId, inline))).status).toBe(403);
      expect((await (await ctx.agent('pm2')).get(url(pdfId, inline))).status).toBe(404);
      expect((await (await ctx.agent('admin')).get(url(pdfId, inline, `/api/projects/${ctx.projects.p2}`))).status).toBe(404);
    }
  });

  it('an expired or missing session gets 401 (JSON for the app, a readable page for a View tab)', async () => {
    expect((await request(ctx.app).get(url(pdfId))).status).toBe(401);
    const json = await request(ctx.app).get(url(pdfId, true)).set('Accept', 'application/json');
    expect(json.status).toBe(401);
    expect(json.body.error).toBeTruthy();
    const page = await request(ctx.app).get(url(pdfId, true)).set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(page.status).toBe(401);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.text).toContain('Sign in to view this file');
    expect(page.text).not.toContain('slip.pdf');
  });

  it('a no-access View tab shows a readable 403 page', async () => {
    const r = await (await ctx.agent('contractor')).get(url(pdfId, true)).set('Accept', 'text/html');
    expect(r.status).toBe(403);
    expect(r.text).toContain('can’t view this file');
  });

  it('a file missing from storage returns 404 (readable page in a View tab), and nothing else changes', async () => {
    const id = await up(PDF, 'gone.pdf');
    const row = (await ctx.pool.query('SELECT stored_name FROM attachments WHERE id = $1', [id])).rows[0];
    fs.rmSync(path.join(ctx.uploadDir, ctx.projects.p1, row.stored_name));
    const api = await pm.get(url(id));
    expect(api.status).toBe(404);
    expect(api.body.error).toBe('File is missing from storage');
    const page = await pm.get(url(id, true)).set('Accept', 'text/html');
    expect(page.status).toBe(404);
    expect(page.text).toContain('File not available');
    expect((await ctx.pool.query('SELECT archived_at FROM attachments WHERE id = $1', [id])).rows[0].archived_at).toBeNull();
  });

  it('archived files stay unavailable on both paths', async () => {
    const id = await up(PDF, 'old.pdf');
    await pm.post(`${P}/attachments/${id}/archive`);
    expect((await pm.get(url(id))).status).toBe(404);
    expect((await pm.get(url(id, true))).status).toBe(404);
  });

  it('consultant reports use the same preview rules without changing who can open them (existing rules)', async () => {
    const admin = await ctx.agent('admin');
    const v = (await admin.post(`${P}/visits/consultant`, { purpose: 'Inspection', planned_at: '2026-09-01T10:00:00+03:00' })).body;
    const r = await admin.upload(P + '/attachments', { entity_type: 'consultant_visit', entity_id: v.id, kind: 'consultant_report' }, { buf: PDF, name: 'report.pdf' });
    const inline = await (await ctx.agent('viewer')).get(url(r.body.id, true));
    expect(inline.status).toBe(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    expect(inline.headers['content-security-policy']).not.toMatch(/\bsandbox\b/);
    // existing access rules for consultant reports are unchanged: another project's manager can't open it
    expect((await (await ctx.agent('pm2')).get(url(r.body.id, true))).status).toBe(404);
  });
});
