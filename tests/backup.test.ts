// Backup & Restore: full round trip into an isolated, separate database ("new server"),
// record / ID / financial / relationship / attachment equality, sign-in after session
// invalidation, rejection of corrupt / unsafe / incompatible archives, and failure handling
// that leaves existing data untouched. Never touches anything but throw-away test databases.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import pg from 'pg';
import { PASSWORD, PDF, PNG, setup, TEST_DB, type Agent, type Ctx } from './helpers';
import { createPool } from '../server/db';
import { createApp } from '../server/app';
import { loadConfig } from '../server/config';
import { readMigrations, runMigrations } from '../server/lib/migrate';
import { hashPassword } from '../server/lib/passwords';
import { resetLoginThrottle } from '../server/auth';
import type { BackupService, Operation } from '../server/backup/service';
import type { OpsState } from '../server/backup/ops';
import { createBackup } from '../server/backup/create';
import { validateArchive, checkCompatibility } from '../server/backup/validate';
import { BackupStore } from '../server/backup/store';
import { readTar, TarWriter, tarHeader, readEntryBuffer, entryStream } from '../server/backup/tar';
import { RestoreJournal, recoverInterruptedRestores } from '../server/backup/restore';
import type { AppInfo } from '../server/backup/format';

const MIGRATIONS = path.resolve('migrations');
const APP: AppInfo = { name: 'qonnect-smart-house', version: 'test', commit: 'abc1234', migrations: readMigrations(MIGRATIONS) };
const dbUrl = (name: string) => { const u = new URL(TEST_DB); u.pathname = `/${name}`; return u.toString(); };

async function recreateDb(name: string) {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}
async function dropDb(name: string) {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.end();
}

interface Install { name: string; pool: pg.Pool; app: ReturnType<typeof createApp>; svc: BackupService; ops: OpsState; uploadDir: string; backupDir: string; close: () => Promise<void> }
/** A separate, freshly installed application (own database, uploads and backup storage). */
async function freshInstall(name: string, opts: { migrate?: boolean } = {}): Promise<Install> {
  await recreateDb(name);
  const pool = createPool(dbUrl(name));
  if (opts.migrate !== false) {
    await runMigrations(pool, MIGRATIONS, () => undefined);
    await pool.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('fresh@test.local', 'Fresh admin', 'admin', $1)`, [await hashPassword(PASSWORD)]);
  }
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), `sh-up-${name}-`));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), `sh-bk-${name}-`));
  const cfg = loadConfig({ databaseUrl: dbUrl(name), uploadDir, backupDir, cookieSecure: false, nodeEnv: 'test', staticDir: '/nonexistent', maxUploadMb: 1, notifySchedulerEnabled: false });
  const app = createApp(pool, cfg);
  return {
    name, pool, app, svc: app.locals.backup, ops: app.locals.ops, uploadDir, backupDir,
    close: async () => { await pool.end(); fs.rmSync(uploadDir, { recursive: true, force: true }); fs.rmSync(backupDir, { recursive: true, force: true }); await dropDb(name); },
  };
}

async function login(app: ReturnType<typeof createApp>, email: string, password = PASSWORD) {
  resetLoginThrottle();
  const raw = request.agent(app);
  const res = await raw.post('/api/auth/login').send({ email, password });
  return { raw, res, csrf: res.body.csrfToken as string };
}

async function waitOp(svc: BackupService, op: { id: string }): Promise<Operation> {
  for (let i = 0; i < 600; i++) {
    if (svc.last?.id === op.id && !svc.current) return svc.last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('operation did not finish');
}

const SKIP = new Set(['sessions', 'push_subscriptions', 'schema_migrations']);
/** Every row of every application table as JSON text, sorted (IDs, dates and amounts exactly). */
async function dump(pool: pg.Pool): Promise<Record<string, string[]>> {
  const { rows } = await pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
  const out: Record<string, string[]> = {};
  const c = await pool.connect();
  try {
    await c.query(`SET TimeZone = 'UTC'`);
    for (const r of rows) {
      if (SKIP.has(r.relname)) continue;
      out[r.relname] = (await c.query(`SELECT row_to_json(t)::text AS j FROM public."${r.relname}" t`)).rows.map((x) => x.j).sort();
    }
  } finally {
    await c.query(`RESET TimeZone`);
    c.release();
  }
  return out;
}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** Rewrites an archive with modified schema / manifest and recomputed checksums (a structurally valid archive). */
async function repack(src: string, dest: string, edit: (schema: any, manifest: any) => void) {
  const entries = [];
  for await (const e of readTar(src)) entries.push(e);
  const schema = JSON.parse((await readEntryBuffer(src, entries.find((e) => e.name === 'database/schema.json')!, 1e8)).toString());
  const manifest = JSON.parse((await readEntryBuffer(src, entries.find((e) => e.name === 'manifest.json')!, 1e8)).toString());
  edit(schema, manifest);
  const w = await TarWriter.create(dest);
  for (const e of entries) {
    if (e.name === 'manifest.json') continue;
    if (e.name === 'database/schema.json') { await w.addBuffer(e.name, Buffer.from(JSON.stringify(schema))); continue; }
    const tmp = `${dest}.entry`;
    await new Promise<void>((res, rej) => entryStream(src, e).pipe(fs.createWriteStream(tmp)).on('finish', () => res()).on('error', rej));
    await w.addFile(e.name, tmp, e.size);
    fs.rmSync(tmp);
  }
  manifest.entries = [...w.entries];
  await w.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest)));
  await w.finish();
}

let src: Ctx;
let admin: Agent;
let pm: Agent;
let P1: string;
let target: Install;
let archive = '';
let before: Record<string, string[]>;
let backupId = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-bk-test-'));
const ids: Record<string, string> = {};
let uploadedId = '';

beforeAll(async () => {
  src = await setup();
  admin = await src.agent('admin');
  pm = await src.agent('pm');
  P1 = `/api/projects/${src.projects.p1}`;
  // ---- realistic records with exact amounts and relationships
  const cat = (await pm.get(`${P1}/categories`)).body.contract[0].id;
  ids.contract = (await pm.post(`${P1}/contracts`, { title: 'Gypsum works', category_id: cat, company_name: 'Gulf Gypsum WLL', contract_value: 180000.25, status: 'Signed' })).body.id;
  ids.milestone = (await pm.post(`${P1}/payments/milestones`, { payee_type: 'contractor', payee_name: 'Gulf Gypsum', description: 'Advance', scheduled_amount: 40000.1, contract_id: ids.contract })).body.id;
  ids.tx = (await pm.post(`${P1}/payments/milestones/${ids.milestone}/transactions`, { amount: 12345.67, paid_date: '2026-09-15', method: 'bank_transfer', reference: 'TRX-BK-1' })).body.id;
  await pm.post(`${P1}/payments/milestones/${ids.milestone}/transactions`, { amount: 0.01, paid_date: '2026-09-16', method: 'cash', reference: 'TRX-BK-2' });
  ids.slip = (await pm.upload(`${P1}/attachments`, { entity_type: 'payment_transaction', entity_id: ids.tx, kind: 'payment_slip' }, { buf: PDF, name: 'slip.pdf' })).body.id;
  ids.signed = (await pm.upload(`${P1}/attachments`, { entity_type: 'contract', entity_id: ids.contract, kind: 'signed_contract' }, { buf: PNG, name: 'signed.png' })).body.id;
  ids.entry = (await admin.post('/api/directory', { display_name: 'Gulf Gypsum WLL', entity_type: 'company', roles: ['subcontractor'], phone: '4400 1122' })).body.id;
  ids.person = (await admin.post(`/api/directory/${ids.entry}/contacts`, { name: 'Ali Hassan', mobile: '+974 5512 3456', is_primary: true })).body.id;
  await admin.post(`/api/directory/${ids.entry}/assignments`, { project_id: src.projects.p1, roles: ['subcontractor'] });
  expect((await admin.patch(`${P1}/contracts/${ids.contract}`, { directory_entry_id: ids.entry, directory_contact_id: ids.person })).status).toBe(200);
  ids.shared = (await admin.upload(`/api/directory/${ids.entry}/documents`, { kind: 'company_profile', visibility: 'shared' }, { buf: PDF, name: 'profile.pdf' })).body.id;
  // things a restore must not carry over: device push registrations (and sessions)
  await src.pool.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://fcm.googleapis.com/x', 'k', 'a')`, [src.users.pm]);
  await src.pool.query(`INSERT INTO notification_preferences (user_id, push_enabled) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET push_enabled = true`, [src.users.pm]);
  target = await freshInstall('smarthouse_test_restore');
});
afterAll(async () => {
  await src?.close();
  await target?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('backup (source installation)', () => {
  it('is admin only', async () => {
    for (const role of ['pm', 'viewer', 'contractor', 'consultant']) {
      const a = await src.agent(role);
      expect((await a.get('/api/admin/backup/status')).status).toBe(403);
      expect((await a.post('/api/admin/backup/backups')).status).toBe(403);
      expect((await a.get('/api/admin/backup/backups')).status).toBe(403);
    }
    expect((await request(src.app).get('/api/admin/backup/backups')).status).toBe(401);
  });

  it('creates a complete, verified archive with manifest, schema, every table and every file', async () => {
    before = await dump(src.pool);
    const r = await admin.post('/api/admin/backup/backups');
    expect(r.status).toBe(202);
    const op = await waitOp(src.app.locals.backup, r.body.operation);
    expect(op.state).toBe('succeeded');
    const list = (await admin.get('/api/admin/backup/backups')).body.backups;
    expect(list[0]).toMatchObject({ status: 'verified', complete: true, kind: 'manual', commit: null });
    backupId = list[0].id;
    expect(list[0].createdBy.email).toBe('admin@test.local');
    expect(list[0].attachments).toMatchObject({ rows: 3, filesIncluded: 3, missing: 0 });
    // download (authenticated, streamed) — identical to the stored archive
    const dl = await admin.raw.get(`/api/admin/backup/backups/${backupId}/download`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="qonnect-backup-\d{8}-\d{6}-[0-9a-f]{8}\.tar"/);
    archive = path.join(tmp, 'source.tar');
    fs.writeFileSync(archive, dl.body as Buffer);
    expect(sha(dl.body as Buffer)).toBe(sha(fs.readFileSync(path.join(src.cfg.backupDir, 'archives', `${backupId}.tar`))));
    const names: string[] = [];
    for await (const e of readTar(archive)) names.push(e.name);
    expect(names[0]).toBe('README.txt');
    expect(names[1]).toBe('database/schema.json');
    expect(names.at(-1)).toBe('manifest.json');
    expect(names).toContain('database/tables/payment_transactions.ndjson.gz');
    expect(names).toContain('database/tables/directory_entries.ndjson.gz');
    expect(names.filter((n) => n.startsWith('files/'))).toHaveLength(3);
    expect(names.some((n) => n.includes('sessions') || n.includes('push_subscriptions'))).toBe(false);
    const audit = (await src.pool.query(`SELECT action FROM audit_log WHERE entity_type = 'system_backup' ORDER BY id`)).rows.map((x) => x.action);
    expect(audit).toEqual(['backup_created', 'backup_downloaded']);
  });

  it('manifest records versions, counts, exact totals and checksums; no secrets', async () => {
    const entries = [];
    for await (const e of readTar(archive)) entries.push(e);
    const m = JSON.parse((await readEntryBuffer(archive, entries.at(-1)!, 1e8)).toString());
    expect(m).toMatchObject({ format: 'qonnect-smarthouse-backup', formatVersion: 1, encryption: 'none', complete: true });
    expect(m.schema.latest).toBe(APP.migrations.at(-1)!.filename);
    expect(m.totals.payment_transactions.amount).toBe('12345.68');
    expect(m.totals.contracts.contract_value).toBe('180000.25');
    expect(m.database.excludedTables).toEqual(['sessions', 'push_subscriptions']);
    expect(m.entries.length).toBe(entries.length - 1);
    const text = fs.readFileSync(archive).toString('latin1');
    expect(text).not.toContain('devpass'); // database password from the connection string
    expect(text).not.toContain('fcm.googleapis.com/x'); // push endpoint
  });

  it('reports a missing attachment file and never calls the backup complete', async () => {
    const row = (await src.pool.query('SELECT project_id, stored_name FROM attachments WHERE id = $1', [ids.signed])).rows[0];
    const file = path.join(src.uploadDir, row.project_id, row.stored_name);
    const keep = fs.readFileSync(file);
    fs.rmSync(file);
    try {
      const store = new BackupStore(path.join(tmp, 'incomplete'));
      const meta = await createBackup({ pool: src.pool, uploadDir: src.uploadDir, store, ops: null, app: APP }, { kind: 'manual', source: 'web', actor: null });
      expect(meta.status).toBe('incomplete');
      expect(meta.complete).toBe(false);
      expect(meta.attachments?.missing).toBe(1);
      expect(meta.warnings.join(' ')).toMatch(/missing/);
      const rep = await validateArchive(store.archivePath(meta.id), { app: APP });
      expect(rep.ok).toBe(true);
      expect(rep.manifest?.complete).toBe(false);
      expect(rep.warnings.join(' ')).toMatch(/INCOMPLETE BACKUP/);
    } finally {
      fs.writeFileSync(file, keep);
    }
  });
});

describe('validation rejects corrupt, unsafe and incompatible archives', () => {
  it('corrupted data (checksum mismatch)', async () => {
    const bad = path.join(tmp, 'corrupt.tar');
    const buf = fs.readFileSync(archive);
    let fileEntry;
    for await (const e of readTar(archive)) if (e.name.startsWith('files/')) { fileEntry = e; break; }
    buf[fileEntry!.offset + 3] ^= 0xff;
    fs.writeFileSync(bad, buf);
    const r = await validateArchive(bad, { app: APP });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Checksum mismatch/);
  });

  it('truncated download', async () => {
    const bad = path.join(tmp, 'truncated.tar');
    const buf = fs.readFileSync(archive);
    fs.writeFileSync(bad, buf.subarray(0, Math.floor(buf.length * 0.6)));
    const r = await validateArchive(bad, { app: APP });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/truncated/);
  });

  it('path traversal, absolute paths, symlinks and unexpected entries', async () => {
    expect(() => tarHeader('../etc/passwd', 1, 0)).toThrow(/unsafe/);
    const mk = async (name: string, mutate: (h: Buffer) => void) => {
      const f = path.join(tmp, `evil-${crypto.randomUUID()}.tar`);
      const h = tarHeader('files/_directory/x.pdf', 4, 0);
      mutate(h);
      let sum = 0;
      h.write('        ', 148, 8, 'ascii');
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      fs.writeFileSync(f, Buffer.concat([h, Buffer.from('abcd'), Buffer.alloc(508), Buffer.alloc(1024 * 3)]));
      return (await validateArchive(f, { app: APP })).errors.join(' ');
    };
    expect(await mk('traversal', (h) => { h.fill(0, 0, 100); h.write('files/../../etc/passwd', 0); })).toMatch(/unsafe path/);
    expect(await mk('absolute', (h) => { h.fill(0, 0, 100); h.write('/etc/passwd', 0); })).toMatch(/unsafe path/);
    expect(await mk('symlink', (h) => { h.write('2', 156); h.write('/etc/passwd', 157); })).toMatch(/unsupported entry type/);
    expect(await mk('hardlink', (h) => { h.write('1', 156); })).toMatch(/unsupported entry type/);
    expect(await mk('pax', (h) => { h.write('x', 156); })).toMatch(/unsupported entry type/);
    expect(await mk('script', (h) => { h.fill(0, 0, 100); h.write('install.sh', 0); })).toMatch(/Unexpected entry/);
    const notTar = path.join(tmp, 'random.bin');
    fs.writeFileSync(notTar, crypto.randomBytes(8192));
    expect((await validateArchive(notTar, { app: APP })).ok).toBe(false);
  });

  it('a backup from a newer application version is rejected before any change', async () => {
    const newer = path.join(tmp, 'newer.tar');
    await repack(archive, newer, (schema, manifest) => {
      schema.migrations.push({ filename: '999_future.sql', checksum: 'x', applied_at: null });
      manifest.schema.migrations.push('999_future.sql');
      manifest.schema.latest = '999_future.sql';
    });
    const r = await validateArchive(newer, { app: APP });
    expect(r.ok).toBe(false);
    expect(r.compatibility.status).toBe('newer');
    expect(r.errors.join(' ')).toMatch(/newer version/);
    expect(checkCompatibility(['001_init.sql'], APP)).toMatchObject({ compatible: true, status: 'older' });
    expect(checkCompatibility(['002_finalized_budget_and_categories.sql'], APP)).toMatchObject({ compatible: false, status: 'different' });
  });

  it('a row that does not match its table is rejected', async () => {
    const bad = path.join(tmp, 'badcolumns.tar');
    await repack(archive, bad, (schema) => { schema.tables.find((t: any) => t.name === 'projects').columns.push({ name: 'extra', type: 'text', generated: false, identity: '' }); });
    const r = await validateArchive(bad, { app: APP });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/does not match the table's columns/);
  });
});

describe('restore into a fresh installation (new server)', () => {
  let tAdmin: Awaited<ReturnType<typeof login>>;
  
  it('upload is chunked and resumable, and validation does not modify anything', async () => {
    tAdmin = await login(target.app, 'fresh@test.local');
    expect(tAdmin.res.status).toBe(200);
    const beforeDump = await dump(target.pool);
    const size = fs.statSync(archive).size;
    const u = await tAdmin.raw.post('/api/admin/backup/uploads').set('X-CSRF-Token', tAdmin.csrf).send({ fileName: 'source.tar', size });
    expect(u.status).toBe(201);
    const id = u.body.upload.id;
    const data = fs.readFileSync(archive);
    const half = Math.floor(size / 2);
    // wrong offset → 409 with the server's position (resume)
    const wrong = await tAdmin.raw.put(`/api/admin/backup/uploads/${id}?offset=5`).set('X-CSRF-Token', tAdmin.csrf).set('Content-Type', 'application/octet-stream').send(data.subarray(0, 10));
    expect(wrong.status).toBe(409);
    expect(wrong.body.received).toBe(0);
    for (const [a, b] of [[0, half], [half, size]]) {
      const r = await tAdmin.raw.put(`/api/admin/backup/uploads/${id}?offset=${a}`).set('X-CSRF-Token', tAdmin.csrf).set('Content-Type', 'application/octet-stream').send(data.subarray(a, b));
      expect(r.status).toBe(200);
      expect(r.body.received).toBe(b);
    }
    const done = await tAdmin.raw.post(`/api/admin/backup/uploads/${id}/complete`).set('X-CSRF-Token', tAdmin.csrf).send({});
    expect(done.status).toBe(202);
    uploadedId = done.body.backup.id;
    const op = await waitOp(target.svc, done.body.operation);
    expect(op.state).toBe('succeeded');
    const meta = (await tAdmin.raw.get(`/api/admin/backup/backups/${uploadedId}`)).body;
    expect(meta.backup.status).toBe('valid');
    expect(meta.backup.validation.compatibility.status).toBe('same');
    expect(meta.backup.summary.counts.payment_transactions).toBe(2);
    expect(meta.backup.summary.projects.map((p: { code: string }) => p.code).sort()).toEqual(['PIN 70153016', 'PIN 70153699']);
    expect(meta.confirmation).toBe(`RESTORE ${uploadedId.slice(0, 8)}`);
    const afterDump = await dump(target.pool);
    expect({ ...afterDump, audit_log: [] }).toEqual({ ...beforeDump, audit_log: [] });
    expect(afterDump.audit_log.map((j) => JSON.parse(j).action).filter((a) => a.startsWith('backup_'))).toEqual(['backup_uploaded', 'backup_validated']);
  });

  it('requires password re-check and typed confirmation', async () => {
    const url = `/api/admin/backup/backups/${uploadedId}/restore`;
    let r = await tAdmin.raw.post(url).set('X-CSRF-Token', tAdmin.csrf).send({ password: PASSWORD, confirmation: 'RESTORE' });
    expect(r.status).toBe(400);
    r = await tAdmin.raw.post(url).set('X-CSRF-Token', tAdmin.csrf).send({ password: 'wrong-password-1', confirmation: `RESTORE ${uploadedId.slice(0, 8)}` });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/password/i);
    expect(target.svc.last?.kind).not.toBe('restore');
  });

  it('restores IDs, records, exact amounts, relationships and files; clears sessions and push', async () => {
    const r = await tAdmin.raw.post(`/api/admin/backup/backups/${uploadedId}/restore`).set('X-CSRF-Token', tAdmin.csrf).send({ password: PASSWORD, confirmation: `RESTORE ${uploadedId.slice(0, 8)}` });
    expect(r.status).toBe(202);
    const op = await waitOp(target.svc, r.body.operation);
    expect(op.error).toBeNull();
    expect(op.state).toBe('succeeded');
    const res = op.result as { preRestoreBackupId: string; previousSchema: string; pushPreferencesReset: number; files: { written: number } };
    expect(res.files.written).toBe(3);
    expect(res.pushPreferencesReset).toBe(1);
    expect(res.previousSchema).toMatch(/^pre_restore_/);

    const after = await dump(target.pool);
    // identical except: the restore completion audit event, and push turned off (must be re-enabled per device)
    const expectedPrefs = before.notification_preferences.map((j) => JSON.stringify({ ...JSON.parse(j), push_enabled: false })).sort();
    expect(after.notification_preferences).toEqual(expectedPrefs);
    const restoredAudit = after.audit_log.filter((j) => JSON.parse(j).action !== 'restore_completed');
    expect(restoredAudit).toEqual(before.audit_log);
    expect(after.audit_log.filter((j) => JSON.parse(j).action === 'restore_completed')).toHaveLength(1);
    for (const t of Object.keys(before)) {
      if (t === 'audit_log' || t === 'notification_preferences') continue;
      expect(after[t], t).toEqual(before[t]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect((await target.pool.query('SELECT count(*)::int n FROM sessions')).rows[0].n).toBe(0);
    expect((await target.pool.query('SELECT count(*)::int n FROM push_subscriptions')).rows[0].n).toBe(0);
    // exact money and relationships
    const money = (await target.pool.query(`SELECT sum(amount)::text s FROM payment_transactions WHERE milestone_id = $1`, [ids.milestone])).rows[0].s;
    expect(money).toBe('12345.68');
    const rel = (await target.pool.query(
      `SELECT k.contract_value::text, m.scheduled_amount::text, e.display_name, dc.name AS contact
         FROM contracts k JOIN payment_milestones m ON m.contract_id = k.id
         JOIN directory_entries e ON e.id = k.directory_entry_id JOIN directory_contacts dc ON dc.id = k.directory_contact_id
        WHERE k.id = $1`, [ids.contract])).rows[0];
    expect(rel).toEqual({ contract_value: '180000.25', scheduled_amount: '40000.10', display_name: 'Gulf Gypsum WLL', contact: 'Ali Hassan' });
    // sequences continue after restored values
    const maxId = Number((await target.pool.query('SELECT max(id) m FROM audit_log')).rows[0].m);
    await target.pool.query(`INSERT INTO audit_log (action, entity_type) VALUES ('probe', 'test')`);
    expect(Number((await target.pool.query(`SELECT id FROM audit_log WHERE action = 'probe'`)).rows[0].id)).toBeGreaterThan(maxId);
    await target.pool.query(`DELETE FROM audit_log WHERE action = 'probe'`);
    // files identical
    const srcFiles = listFiles(src.uploadDir);
    expect(listFiles(target.uploadDir)).toEqual(srcFiles);
    for (const f of srcFiles) expect(sha(fs.readFileSync(path.join(target.uploadDir, f)))).toBe(sha(fs.readFileSync(path.join(src.uploadDir, f))));
    // background jobs stay paused until an admin resumes them; a safety backup of the replaced data exists
    expect(target.ops.persisted.jobsPaused).toBe(true);
    expect(target.svc.store.readMeta(res.preRestoreBackupId)).toMatchObject({ kind: 'pre_restore', status: 'verified' });
    const prev = await target.pool.query(`SELECT count(*)::int n FROM ${res.previousSchema}.users WHERE email = 'fresh@test.local'`);
    expect(prev.rows[0].n).toBe(1);
  });

  it('old sessions are invalid; restored accounts sign in with their own passwords and project access', async () => {
    expect((await tAdmin.raw.get('/api/auth/me')).status).toBe(401);
    expect((await login(target.app, 'fresh@test.local')).res.status).toBe(401); // that account was replaced
    const a = await login(target.app, 'admin@test.local');
    expect(a.res.status).toBe(200);
    expect(a.res.body.user.role).toBe('admin');
    // authenticated preview / download of restored files
    const dl = await a.raw.get(`/api/projects/${src.projects.p1}/attachments/${ids.slip}/download`);
    expect(dl.status).toBe(200);
    expect(sha(dl.body as Buffer)).toBe(sha(PDF));
    const shared = await a.raw.get(`/api/directory/${ids.entry}/documents/${ids.shared}/download`);
    expect(shared.status).toBe(200);
    // roles and project memberships
    const p = await login(target.app, 'pm@test.local');
    expect((await p.raw.get(`/api/projects/${src.projects.p1}`)).status).toBe(200);
    expect((await p.raw.get(`/api/projects/${src.projects.p2}`)).status).toBe(404);
    expect((await p.raw.get('/api/admin/backup/status')).status).toBe(403);
    const v = await login(target.app, 'viewer@test.local');
    expect((await v.raw.post(`/api/projects/${src.projects.p1}/payments/milestones`).set('X-CSRF-Token', v.csrf).send({ payee_type: 'contractor', payee_name: 'x', description: 'x', scheduled_amount: 1 })).status).toBe(403);
    // status shows the paused jobs; resuming is audited
    const st = (await a.raw.get('/api/admin/backup/status')).body;
    expect(st.jobsPaused).toBe(true);
    expect(st.lastRestore.backupCreatedAt).toBeTruthy();
    expect((await a.raw.post('/api/admin/backup/jobs/resume').set('X-CSRF-Token', a.csrf).send({})).status).toBe(200);
    expect(target.ops.persisted.jobsPaused).toBe(false);
    expect((await target.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'jobs_resumed'`)).rows[0].n).toBe(1);
  });
});

describe('failure handling keeps the existing installation intact', () => {
  for (const failAt of ['during_files', 'before_swap'] as const) {
    it(`a failure ${failAt.replace('_', ' ')} changes no data and leaves no new files`, async () => {
      // change the live data after the restore; a failed restore of the original archive must keep this change
      await target.pool.query(`UPDATE projects SET name = 'Changed after restore' WHERE id = $1`, [src.projects.p1]);
      const dataBefore = await dump(target.pool);
      const filesBefore = listFiles(target.uploadDir);
      const op = await target.svc.startRestore(uploadedId, { id: null, email: 'admin@test.local', name: 'a' }, { testFailAt: failAt });
      const done = await waitOp(target.svc, op);
      expect(done.state).toBe('failed');
      expect(done.error).toMatch(/Simulated failure/);
      const noise = (d: Record<string, string[]>) => ({ ...d, audit_log: d.audit_log.filter((j) => !['restore_started', 'restore_failed', 'backup_created'].includes(JSON.parse(j).action)) });
      expect(noise(await dump(target.pool))).toEqual(noise(dataBefore));
      expect((await target.pool.query('SELECT name FROM projects WHERE id = $1', [src.projects.p1])).rows[0].name).toBe('Changed after restore');
      expect(listFiles(target.uploadDir)).toEqual(filesBefore);
      expect(target.ops.maintenance).toBeNull();
      expect(target.ops.persisted.jobsPaused).toBe(false); // previous state restored
      expect((await target.pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'restore_failed'`)).rows[0].n).toBeGreaterThan(0);
      expect((await target.pool.query(`SELECT count(*)::int n FROM pg_namespace WHERE nspname LIKE 'restore\\_%'`)).rows[0].n).toBe(0);
      // the restore that failed made a safety backup first
      expect(target.svc.store.list().filter((m) => m.kind === 'pre_restore' && m.status === 'verified').length).toBeGreaterThan(1);
    });
  }

  it('a failure while writing new files removes exactly the files it created', async () => {
    // a third installation without any files: the restore must write all 3 files, fail after the first
    const third = await freshInstall('smarthouse_test_restore2');
    try {
      const store = third.svc.store;
      store.ensure();
      const meta = store.newMeta('uploaded', null, 'source.tar', 'valid');
      fs.copyFileSync(archive, store.archivePath(meta.id));
      store.writeMeta(meta);
      const op = await third.svc.startRestore(meta.id, null, { testFailAt: 'during_files' });
      const done = await waitOp(third.svc, op);
      expect(done.state).toBe('failed');
      expect(listFiles(third.uploadDir)).toEqual([]);
      expect((await third.pool.query(`SELECT email FROM users`)).rows.map((x) => x.email)).toEqual(['fresh@test.local']);
    } finally {
      await third.close();
    }
  });

  it('an interrupted restore is undone at the next start (journaled files removed)', async () => {
    const store = new BackupStore(path.join(tmp, 'journal-test'));
    const up = path.join(tmp, 'journal-uploads');
    const dir = path.join(up, '_directory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep.pdf'), 'existing');
    const id = crypto.randomUUID();
    const j = new RestoreJournal(store, up, id);
    j.start('x.tar');
    j.add('_directory/new.pdf');
    fs.writeFileSync(path.join(dir, 'new.pdf'), 'half-restored');
    const out = await recoverInterruptedRestores(target.pool, store, up);
    expect(out).toEqual([{ restoreId: id, outcome: 'rolled_back' }]);
    expect(fs.readdirSync(dir)).toEqual(['keep.pdf']);
  });
});

describe('older backups and maintenance mode', () => {
  it('a backup from an older database version restores and the newer changes are applied', async () => {
    const old = await freshInstall('smarthouse_test_old', { migrate: false });
    const fresh = await freshInstall('smarthouse_test_new');
    try {
      const dir = fs.mkdtempSync(path.join(tmp, 'mig-'));
      const six = APP.migrations.filter((m) => m.filename < '007');
      for (const m of six) fs.writeFileSync(path.join(dir, m.filename), m.sql);
      await runMigrations(old.pool, dir, () => undefined);
      await old.pool.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('old@test.local', 'Old', 'admin', $1)`, [await hashPassword(PASSWORD)]);
      const oldApp: AppInfo = { ...APP, migrations: six };
      const store = new BackupStore(path.join(tmp, 'old-store'));
      const meta = await createBackup({ pool: old.pool, uploadDir: old.uploadDir, store, ops: null, app: oldApp }, { kind: 'manual', source: 'web', actor: null });
      expect(meta.status).toBe('verified');
      const rep = await validateArchive(store.archivePath(meta.id), { app: APP });
      expect(rep.compatibility).toMatchObject({ compatible: true, status: 'older', pendingMigrations: ['007_directory.sql'] });
      fresh.svc.store.ensure();
      const m2 = fresh.svc.store.newMeta('uploaded', null, 'old.tar', 'valid');
      fs.copyFileSync(store.archivePath(meta.id), fresh.svc.store.archivePath(m2.id));
      fresh.svc.store.writeMeta(m2);
      const done = await waitOp(fresh.svc, await fresh.svc.startRestore(m2.id, null));
      expect(done.error).toBeNull();
      expect((done.result as { pendingMigrationsApplied: string[] }).pendingMigrationsApplied).toEqual(['007_directory.sql']);
      expect((await fresh.pool.query(`SELECT filename FROM schema_migrations ORDER BY 1`)).rows.map((r) => r.filename)).toEqual(APP.migrations.map((m) => m.filename));
      expect((await fresh.pool.query(`SELECT count(*)::int n FROM directory_specializations`)).rows[0].n).toBe(10);
      expect((await login(fresh.app, 'old@test.local')).res.status).toBe(200);
    } finally {
      await old.close();
      await fresh.close();
    }
  });

  it('maintenance mode blocks the API except status; a write freeze holds writes briefly', async () => {
    const a = await login(target.app, 'admin@test.local');
    await target.ops.enterMaintenance('Restoring');
    try {
      expect((await a.raw.get(`/api/projects`)).status).toBe(503);
      expect((await request(target.app).get('/api/system/status')).body).toEqual({ maintenance: true, message: 'Restoring' });
      expect((await request(target.app).get('/api/health')).status).toBe(200);
    } finally {
      target.ops.exitMaintenance();
    }
    expect((await a.raw.get(`/api/projects`)).status).toBe(200);
    let released = false;
    const freeze = target.ops.freezeWrites(async () => { await new Promise((r) => setTimeout(r, 300)); released = true; });
    const w = await a.raw.post('/api/auth/change-password').set('X-CSRF-Token', a.csrf).send({ currentPassword: 'nope-nope-1', newPassword: 'x' });
    await freeze;
    expect(released).toBe(true);
    expect(w.status).toBe(400); // processed after the freeze, not rejected
  });
});

describe('switching back to the data from before a restore (CLI previous-db)', () => {
  it('rollback swaps back, sessions are cleared, discard drops the kept copy', async () => {
    expect(await target.svc.previousDb('status', null)).toMatch(/pre_restore_/);
    const emails = async () => (await target.pool.query('SELECT email FROM users ORDER BY email')).rows.map((r) => r.email);
    expect(await emails()).toContain('admin@test.local');
    await target.svc.previousDb('rollback', null);
    expect(await emails()).toEqual(['fresh@test.local']);
    expect((await target.pool.query('SELECT count(*)::int n FROM sessions')).rows[0].n).toBe(0);
    await target.svc.previousDb('rollback', null); // and back again
    expect(await emails()).toContain('admin@test.local');
    await target.svc.previousDb('discard', null);
    expect(await target.svc.previousDb('status', null)).toBe('No previous data is kept.');
    target.ops.resumeJobs();
  });
});
