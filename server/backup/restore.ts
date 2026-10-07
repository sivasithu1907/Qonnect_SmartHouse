// Full-system restore of a validated archive.
//
// Database: everything happens in ONE PostgreSQL transaction. The application's own migration
// files build an empty copy of the schema in a private staging schema, the archived rows are
// loaded into it, every foreign key is re-validated and counts / numeric totals are compared
// with the manifest. Only then are the schemas swapped (public → pre_restore_<stamp>,
// staging → public). Any failure before COMMIT leaves the live database exactly as it was.
//
// Files: uploaded files are only ever ADDED. A file is written under a temporary name, its
// SHA-256 checked and then hard-linked into place, never replacing an existing file. Every
// newly created path is journaled first, so a failed or interrupted restore removes exactly
// the files it created and nothing else. Files of the previous installation are left in place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type pg from 'pg';
import {
  EXCLUDED_TABLES, FILE_DIR_RE, FILE_NAME_RE, MIGRATIONS_TABLE, attachmentRelPath, qi, tableEntryPath,
  type AppInfo, type Manifest, type SchemaFile,
} from './format';
import { describeSchema, foreignKeys, listTables, numericTotals, rowCount, schemaExists, SNAPSHOT_SETTINGS } from './dbinfo';
import { entryStream, readEntryBuffer, readTar, type TarEntry } from './tar';
import { scanNdjson, type ValidationReport } from './validate';
import { freeBytes, type BackupStore } from './store';
import type { Progress } from './create';

export interface RestoreDeps { pool: pg.Pool; uploadDir: string; store: BackupStore; app: AppInfo }
export interface RestoreResult {
  restoreId: string;
  backupId: string;
  backupCreatedAt: string;
  tables: number;
  rows: number;
  files: { written: number; reused: number; missingInBackup: number };
  pendingMigrationsApplied: string[];
  pushPreferencesReset: number;
  previousSchema: string | null;
  warnings: string[];
}

export const STAGING_PREFIX = 'restore_';
export const PREVIOUS_PREFIX = 'pre_restore_';
export const PREVIOUS_RE = /^pre_restore_\d{8}_\d{6}$/;
const stagingName = (restoreId: string) => `${STAGING_PREFIX}${restoreId.replace(/-/g, '').slice(0, 12)}`;

// ---------------------------------------------------------------- file journal
interface JournalState { restoreId: string; startedAt: string; state: 'running' | 'committed' | 'rolled_back'; archive: string }

export class RestoreJournal {
  private stateFile: string;
  private filesFile: string;
  constructor(private store: BackupStore, private uploadDir: string, readonly restoreId: string) {
    this.stateFile = path.join(store.journal, `${restoreId}.json`);
    this.filesFile = path.join(store.journal, `${restoreId}.files`);
  }
  start(archive: string) {
    this.store.ensure();
    this.write({ restoreId: this.restoreId, startedAt: new Date().toISOString(), state: 'running', archive: path.basename(archive) });
    fs.writeFileSync(this.filesFile, '', { mode: 0o600 });
  }
  private write(s: JournalState) {
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
  read(): JournalState | null {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return null; }
  }
  /** Records a path BEFORE the file is created, so cleanup always knows about it. */
  add(rel: string) { fs.appendFileSync(this.filesFile, `${rel}\n`); }
  commit() { const s = this.read(); if (s) this.write({ ...s, state: 'committed' }); }
  /** Removes only the files this restore created. */
  rollback(): number {
    let removed = 0;
    let list: string[] = [];
    try { list = fs.readFileSync(this.filesFile, 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
    for (const rel of list) {
      const [dir, name, ...rest] = rel.split('/');
      if (rest.length || !FILE_DIR_RE.test(dir ?? '') || !FILE_NAME_RE.test(name ?? '')) continue;
      const dest = path.join(this.uploadDir, dir, name);
      for (const p of fs.existsSync(path.dirname(dest)) ? fs.readdirSync(path.dirname(dest)).filter((n) => n.startsWith(`${name}.restoring-`)) : []) {
        fs.rmSync(path.join(path.dirname(dest), p), { force: true });
      }
      if (fs.existsSync(dest)) { fs.rmSync(dest, { force: true }); removed++; }
    }
    const s = this.read();
    if (s) this.write({ ...s, state: 'rolled_back' });
    return removed;
  }
  static list(store: BackupStore): string[] {
    try { return fs.readdirSync(store.journal).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { return []; }
  }
}

/**
 * Startup recovery for a restore that was interrupted (process crash, container stop).
 * The database transaction was rolled back by PostgreSQL unless it had committed; this
 * decides which, removes the files of an uncommitted restore and drops leftover staging schemas.
 */
export async function recoverInterruptedRestores(pool: pg.Pool, store: BackupStore, uploadDir: string): Promise<Array<{ restoreId: string; outcome: 'committed' | 'rolled_back' }>> {
  const out: Array<{ restoreId: string; outcome: 'committed' | 'rolled_back' }> = [];
  for (const id of RestoreJournal.list(store)) {
    const j = new RestoreJournal(store, uploadDir, id);
    const s = j.read();
    if (!s || s.state !== 'running') continue;
    let committed = false;
    try {
      committed = (await pool.query(`SELECT 1 FROM audit_log WHERE action = 'restore_completed' AND entity_id = $1`, [id])).rowCount === 1;
    } catch (e) {
      // no audit_log at all means the restore never committed; any other error: decide on a later start
      if ((e as { code?: string }).code !== '42P01') continue;
    }
    if (committed) { j.commit(); out.push({ restoreId: id, outcome: 'committed' }); }
    else { j.rollback(); out.push({ restoreId: id, outcome: 'rolled_back' }); }
  }
  try {
    const { rows } = await pool.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^restore_[0-9a-f]{12}$'`);
    for (const r of rows) await pool.query(`DROP SCHEMA ${qi(r.nspname)} CASCADE`);
  } catch { /* database not ready: nothing to drop */ }
  return out;
}

// ---------------------------------------------------------------- restore
async function hashFile(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const b of fs.createReadStream(p)) h.update(b as Buffer);
  return h.digest('hex');
}

function sameColumns(a: SchemaFile['tables'][number], b: SchemaFile['tables'][number]): string | null {
  const key = (t: typeof a) => t.columns.map((c) => `${c.name}:${c.type}`).sort().join('|');
  if (key(a) === key(b)) return null;
  const an = new Set(a.columns.map((c) => `${c.name} ${c.type}`));
  const bn = new Set(b.columns.map((c) => `${c.name} ${c.type}`));
  const onlyA = [...an].filter((x) => !bn.has(x));
  const onlyB = [...bn].filter((x) => !an.has(x));
  return `${a.name}: backup has [${onlyA.join(', ') || '—'}], this version has [${onlyB.join(', ') || '—'}]`;
}

export async function restoreArchive(
  deps: RestoreDeps,
  file: string,
  opts: { restoreId: string; actor: { id: string | null; email: string | null; name: string | null } | null; report: ValidationReport; progress?: Progress; testFailAt?: 'before_swap' | 'during_files' },
): Promise<RestoreResult> {
  const { pool, store, uploadDir, app } = deps;
  const progress = opts.progress ?? (() => undefined);
  if (!opts.report.ok || !opts.report.compatibility.compatible) throw new Error('The archive has not passed validation.');

  // ---- read the archive index, schema and manifest (headers only; data is streamed later)
  const entries: TarEntry[] = [];
  for await (const e of readTar(file)) entries.push(e);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const schemaEntry = byName.get('database/schema.json');
  const manifestEntry = byName.get('manifest.json');
  if (!schemaEntry || !manifestEntry) throw new Error('The archive is incomplete.');
  const schema = JSON.parse((await readEntryBuffer(file, schemaEntry, 64 * 1024 * 1024)).toString('utf8')) as SchemaFile;
  const manifest = JSON.parse((await readEntryBuffer(file, manifestEntry, 64 * 1024 * 1024)).toString('utf8')) as Manifest;
  const expectedSha = new Map(manifest.entries.map((x) => [x.path, x.sha256]));
  const backupMigrations = schema.migrations.map((m) => m.filename);
  const appByName = new Map(app.migrations.map((m) => [m.filename, m]));
  const pending = app.migrations.slice(backupMigrations.length);
  if (backupMigrations.some((m, i) => app.migrations[i]?.filename !== m)) throw new Error('The archive is not compatible with this application version.');

  // ---- disk space for files that are not already present
  const fileEntries = entries.filter((e) => e.name.startsWith('files/'));
  const needFiles = fileEntries.reduce((a, e) => a + e.size, 0);
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });
  const free = await freeBytes(uploadDir);
  if (free < needFiles * 1.05 + 64 * 1024 * 1024) throw new Error(`Not enough free disk space for the uploaded files: ${Math.ceil(needFiles / 1024 / 1024)} MB needed, ${Math.floor(free / 1024 / 1024)} MB free.`);

  const staging = stagingName(opts.restoreId);
  const journal = new RestoreJournal(store, uploadDir, opts.restoreId);
  journal.start(file);
  const warnings: string[] = [];
  const c = await pool.connect();
  let totalRows = 0;
  let written = 0;
  let reused = 0;
  let resetPush = 0;
  let previousSchema: string | null = null;
  try {
    await c.query('BEGIN');
    for (const s of SNAPSHOT_SETTINGS) await c.query(s);
    await c.query(`SET LOCAL lock_timeout = '60s'`);
    await c.query(`DROP SCHEMA IF EXISTS ${qi(staging)} CASCADE`);
    await c.query(`CREATE SCHEMA ${qi(staging)}`);
    await c.query(`SET LOCAL search_path TO ${qi(staging)}`);

    // ---- 1. empty schema at the backup's database version, built from this version's migrations
    await c.query(`CREATE TABLE ${MIGRATIONS_TABLE} (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const appliedAt = new Map(schema.migrations.map((m) => [m.filename, m.applied_at]));
    const runMigration = async (filename: string) => {
      const mf = appByName.get(filename)!;
      await c.query(`SAVEPOINT mig`);
      try {
        await c.query(mf.sql);
        await c.query(`RELEASE SAVEPOINT mig`);
      } catch (e) {
        throw new Error(`Database change ${filename} could not be applied in the staging area: ${(e as Error).message}`);
      }
      await c.query(`INSERT INTO ${MIGRATIONS_TABLE} (filename, checksum, applied_at) VALUES ($1, $2, COALESCE($3::timestamptz, now()))`, [filename, mf.checksum, appliedAt.get(filename) ?? null]);
    };
    let i = 0;
    for (const f of backupMigrations) { progress('Preparing an isolated staging copy of the database', ++i, backupMigrations.length); await runMigration(f); }

    // ---- 2. the staged structure must match the archive exactly
    const staged = await describeSchema(c, staging, [...EXCLUDED_TABLES, MIGRATIONS_TABLE]);
    const problems: string[] = [];
    for (const t of schema.tables) {
      const s = staged.find((x) => x.name === t.name);
      if (!s) { problems.push(`table ${t.name} does not exist in this version`); continue; }
      const d = sameColumns(t, s);
      if (d) problems.push(d);
    }
    for (const s of staged) if (!schema.tables.some((t) => t.name === s.name)) problems.push(`table ${s.name} is missing from the backup`);
    if (problems.length) throw new Error(`The backup's database structure does not match this application version: ${problems.slice(0, 5).join('; ')}`);

    // ---- 3. load rows (constraints re-validated afterwards, user triggers off so rows stay exactly as archived)
    const allTables = await listTables(c, staging);
    const dataTables = allTables.filter((t) => t !== MIGRATIONS_TABLE);
    if (dataTables.length) await c.query(`TRUNCATE ${dataTables.map(qi).join(', ')}`);
    const fks = await foreignKeys(c, staging);
    for (const fk of fks) await c.query(`ALTER TABLE ${qi(fk.table)} DROP CONSTRAINT ${qi(fk.name)}`);
    for (const t of dataTables) await c.query(`ALTER TABLE ${qi(t)} DISABLE TRIGGER USER`);

    const budget = { left: Number.MAX_SAFE_INTEGER };
    i = 0;
    for (const mt of manifest.database.tables) {
      progress(`Loading ${mt.name}`, ++i, manifest.database.tables.length);
      const def = schema.tables.find((t) => t.name === mt.name)!;
      const e = byName.get(tableEntryPath(mt.name));
      if (!e) throw new Error(`Table data missing: ${mt.name}`);
      const cols = def.columns.filter((col) => !col.generated);
      const colList = cols.map((col) => qi(col.name)).join(', ');
      const overriding = cols.some((col) => col.identity === 'a') ? 'OVERRIDING SYSTEM VALUE' : '';
      const sql = `INSERT INTO ${qi(mt.name)} (${colList}) ${overriding} SELECT ${colList} FROM json_populate_recordset(NULL::${qi(mt.name)}, $1::json)`;
      let batch: string[] = [];
      let batchBytes = 0;
      let rows = 0;
      const flush = async () => {
        if (!batch.length) return;
        await c.query(sql, [`[${batch.join(',')}]`]);
        batch = [];
        batchBytes = 0;
      };
      const sha = await scanNdjson(file, e, budget, async (line) => {
        batch.push(line);
        batchBytes += line.length;
        rows++;
        if (batch.length >= 1000 || batchBytes > 4 * 1024 * 1024) await flush();
      });
      await flush();
      if (sha !== expectedSha.get(e.name)) throw new Error(`Checksum mismatch while restoring ${mt.name}; the archive changed after validation.`);
      if (rows !== mt.rows) throw new Error(`Row count mismatch while restoring ${mt.name}`);
      totalRows += rows;
    }

    // sequences continue after the restored values
    for (const sq of schema.sequences) {
      if (sq.last_value === null) continue;
      const ok = await c.query(`SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname = $1 AND cl.relname = $2 AND cl.relkind = 'S'`, [staging, sq.name]);
      if (!ok.rowCount) continue;
      await c.query(`SELECT setval(format('%I.%I', $1::text, $2::text)::regclass, $3::bigint, $4::boolean)`, [staging, sq.name, sq.last_value, sq.is_called]);
    }

    // ---- 4. relationships, counts and exact numeric totals
    progress('Checking record relationships');
    for (const fk of fks) {
      try {
        await c.query(`SAVEPOINT fk`);
        await c.query(`ALTER TABLE ${qi(fk.table)} ADD CONSTRAINT ${qi(fk.name)} ${fk.def}`);
        await c.query(`RELEASE SAVEPOINT fk`);
      } catch (e) {
        throw new Error(`Record relationships in the backup are inconsistent (${fk.table}.${fk.name}): ${(e as Error).message}`);
      }
    }
    for (const t of dataTables) await c.query(`ALTER TABLE ${qi(t)} ENABLE TRIGGER USER`);
    progress('Comparing record counts and financial totals');
    for (const mt of manifest.database.tables) {
      const n = await rowCount(c, staging, mt.name);
      if (n !== mt.rows) throw new Error(`Restored row count for ${mt.name} is ${n}, expected ${mt.rows}`);
      const def = schema.tables.find((t) => t.name === mt.name)!;
      const sums = await numericTotals(c, staging, mt.name, def.columns);
      const want = manifest.totals?.[mt.name];
      const keys = new Set([...Object.keys(want ?? {}), ...Object.keys(sums ?? {})]);
      for (const k of keys) {
        if ((sums?.[k] ?? null) !== (want?.[k] ?? null)) throw new Error(`Restored total of ${mt.name}.${k} is ${sums?.[k]}, the backup recorded ${want?.[k]}`);
      }
    }

    // ---- 5. recovery adjustments: devices must re-enable push; nothing is re-sent
    const hasPrefs = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'notification_preferences' AND column_name = 'push_enabled'`, [staging]);
    if (hasPrefs.rowCount) resetPush = (await c.query(`UPDATE notification_preferences SET push_enabled = false WHERE push_enabled`)).rowCount ?? 0;

    // ---- 6. newer database changes of this version (older backups)
    i = 0;
    for (const m of pending) { progress('Applying newer database changes', ++i, pending.length); await runMigration(m.filename); }

    // ---- 7. uploaded files: add only, verify each checksum, never overwrite
    const known = new Map<string, string>();
    i = 0;
    const root = path.resolve(uploadDir);
    for (const e of fileEntries) {
      progress('Restoring uploaded files', ++i, fileEntries.length);
      const [, dir, name] = e.name.split('/');
      if (!FILE_DIR_RE.test(dir) || !FILE_NAME_RE.test(name)) throw new Error(`Unsafe file entry ${e.name}`);
      const rel = `${dir}/${name}`;
      const dest = path.resolve(root, dir, name);
      if (!dest.startsWith(root + path.sep)) throw new Error(`Unsafe file entry ${e.name}`);
      const want = expectedSha.get(e.name);
      if (!want) throw new Error(`File not listed in the manifest: ${e.name}`);
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(dest); } catch { st = null; }
      if (st) {
        if (!st.isFile()) throw new Error(`Cannot restore ${rel}: something other than a file exists at that path.`);
        const have = await hashFile(dest);
        if (have !== want) throw new Error(`Cannot restore ${rel}: a different file with the same name already exists. Nothing was replaced.`);
        reused++;
        known.set(rel, have);
        if (opts.testFailAt === 'during_files') throw new Error('Simulated failure while restoring files (test)');
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o750 });
      journal.add(rel);
      const tmp = `${dest}.restoring-${opts.restoreId.slice(0, 8)}`;
      const hash = crypto.createHash('sha256');
      const fh = await fs.promises.open(tmp, 'wx', 0o640);
      try {
        for await (const b of entryStream(file, e)) {
          hash.update(b as Buffer);
          await fh.write(b as Buffer);
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      const got = hash.digest('hex');
      if (got !== want) { fs.rmSync(tmp, { force: true }); throw new Error(`Checksum mismatch while restoring ${rel}`); }
      await fs.promises.link(tmp, dest); // fails instead of replacing if the name exists
      await fs.promises.unlink(tmp);
      written++;
      known.set(rel, got);
      if (opts.testFailAt === 'during_files') throw new Error('Simulated failure while restoring files (test)');

    }

    // ---- 8. every attachment record has its file (except files already missing at backup time)
    const missingIds = new Set(manifest.attachments.missing.map((x) => x.id));
    const mismatchedIds = new Set(manifest.attachments.mismatched.map((x) => x.id));
    const { rows: att } = await c.query(`SELECT id, project_id, stored_name, sha256 FROM attachments`);
    for (const a of att) {
      if (missingIds.has(a.id)) continue;
      const rel = attachmentRelPath(a);
      const have = rel ? known.get(rel) : undefined;
      if (!have) throw new Error(`Attachment ${a.id} has no file after restoring`);
      if (have !== a.sha256 && !mismatchedIds.has(a.id)) throw new Error(`Attachment ${a.id} file checksum does not match its record`);
    }
    if (missingIds.size) warnings.push(`${missingIds.size} attachment record(s) were restored without a file (the file was already missing when the backup was made).`);
    if (opts.testFailAt === 'before_swap') throw new Error('Simulated failure before the switch (test)');

    // ---- 9. switch: keep the previous data as pre_restore_<stamp>, staging becomes public
    progress('Switching to the restored data');
    const { rows: exts } = await c.query(
      `SELECT e.extname, e.extrelocatable FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = 'public'`);
    for (const x of exts) {
      // Keep extensions in the live schema when possible. The application does not depend on
      // extension functions (gen_random_uuid is built into PostgreSQL), so an extension that
      // cannot be moved (not relocatable, or owned by another role) simply stays with the
      // previous data.
      if (!x.extrelocatable) { warnings.push(`Extension ${x.extname} stays with the previous data (${PREVIOUS_PREFIX}…).`); continue; }
      await c.query('SAVEPOINT ext');
      try {
        await c.query(`ALTER EXTENSION ${qi(x.extname)} SET SCHEMA ${qi(staging)}`);
        await c.query('RELEASE SAVEPOINT ext');
      } catch {
        await c.query('ROLLBACK TO SAVEPOINT ext');
        warnings.push(`Extension ${x.extname} stays with the previous data (not owned by the application's database user).`);
      }
    }
    const { rows: older } = await c.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^pre_restore_[0-9]{8}_[0-9]{6}$'`);
    for (const o of older) await c.query(`DROP SCHEMA ${qi(o.nspname)} CASCADE`);
    let publicExists = await schemaExists(c, 'public');
    if (publicExists && (await listTables(c, 'public')).length === 0) {
      // a brand-new, never-migrated database: nothing to keep
      await c.query('SAVEPOINT drop_public');
      try { await c.query('DROP SCHEMA public'); await c.query('RELEASE SAVEPOINT drop_public'); publicExists = false; }
      catch { await c.query('ROLLBACK TO SAVEPOINT drop_public'); }
    }
    if (publicExists) {
      const d = new Date();
      previousSchema = `${PREVIOUS_PREFIX}${d.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}`;
      await c.query(`ALTER SCHEMA public RENAME TO ${qi(previousSchema)}`);
    }
    await c.query(`ALTER SCHEMA ${qi(staging)} RENAME TO public`);
    await c.query(`SET LOCAL search_path TO public`);
    await c.query(
      `INSERT INTO audit_log (project_id, user_id, user_email, action, entity_type, entity_id, summary, after)
       VALUES (NULL, NULL, $1, 'restore_completed', 'system_backup', $2, $3, $4)`,
      [opts.actor?.email ?? 'cli', opts.restoreId,
        `Full restore completed from backup of ${manifest.createdAt} (${totalRows} rows, ${written + reused} files). Sessions and device push registrations were cleared.`,
        JSON.stringify({ restoreId: opts.restoreId, backupId: manifest.backupId, backupCreatedAt: manifest.createdAt, app: manifest.app, actor: opts.actor, previousSchema, pendingMigrations: pending.map((m) => m.filename) })],
    );
    await c.query('COMMIT');
    journal.commit();
    return {
      restoreId: opts.restoreId, backupId: manifest.backupId, backupCreatedAt: manifest.createdAt, tables: manifest.database.tables.length, rows: totalRows,
      files: { written, reused, missingInBackup: missingIds.size }, pendingMigrationsApplied: pending.map((m) => m.filename),
      pushPreferencesReset: resetPush, previousSchema, warnings,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    journal.rollback();
    throw e;
  } finally {
    c.release();
  }
}

/** Closes idle pooled connections so no connection keeps state from before the switch. */
export async function drainIdleConnections(pool: pg.Pool) {
  const held: pg.PoolClient[] = [];
  try {
    while (pool.idleCount > 0 && held.length < 50) held.push(await pool.connect());
  } finally {
    for (const h of held) h.release(true);
  }
}
