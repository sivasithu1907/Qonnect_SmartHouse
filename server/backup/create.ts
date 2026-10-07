// Creates a full backup archive: one consistent database snapshot plus every referenced file.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type pg from 'pg';
import {
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, EXCLUDED_TABLES, MIGRATIONS_TABLE, README, attachmentRelPath, fmtBytes, qi, tableEntryPath,
  type AppInfo, type Manifest, type ManifestTable, type SchemaFile,
} from './format';
import { describeSchema, listSequences, numericTotals, SNAPSHOT_SETTINGS } from './dbinfo';
import { TarWriter } from './tar';
import { freeBytes, type BackupMeta, type BackupStore } from './store';
import type { OpsState } from './ops';
import { validateArchive } from './validate';

export type Progress = (phase: string, done?: number, total?: number) => void;

export interface CreateDeps { pool: pg.Pool; uploadDir: string; store: BackupStore; ops: OpsState | null; app: AppInfo }

export { BACKUP_COUNT_LABELS as COUNT_LABELS } from '../../shared/backup';

async function writeLine(gz: zlib.Gzip, line: string) {
  if (!gz.write(line)) await new Promise<void>((r) => gz.once('drain', r));
}

/** Exports one table (inside the snapshot transaction) to a gzip NDJSON file. */
async function exportTable(c: pg.PoolClient, table: string, file: string, onRow?: (json: string) => void) {
  const out = fs.createWriteStream(file, { mode: 0o600 });
  const gz = zlib.createGzip({ level: 6 });
  const done = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.on('error', reject); });
  gz.pipe(out);
  let rows = 0;
  let bytes = 0;
  const cur = `bk_${table}`.slice(0, 60);
  await c.query(`DECLARE ${qi(cur)} NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM public.${qi(table)} t`);
  for (;;) {
    const { rows: batch } = await c.query(`FETCH 2000 FROM ${qi(cur)}`);
    if (!batch.length) break;
    for (const r of batch) {
      const line = `${r.j}\n`;
      rows++;
      bytes += Buffer.byteLength(line);
      onRow?.(r.j);
      await writeLine(gz, line);
    }
  }
  await c.query(`CLOSE ${qi(cur)}`);
  gz.end();
  await done;
  return { rows, uncompressedBytes: bytes };
}

const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
export const backupFileName = (d: Date, id: string) => `qonnect-backup-${stampOf(d)}-${id.slice(0, 8)}.tar`;

/**
 * Creates and verifies one archive. The caller holds the backup/restore lock. The returned
 * metadata has status 'verified' (complete), 'incomplete' (files missing or damaged in the
 * live storage) or 'failed'.
 */
export async function createBackup(
  deps: CreateDeps,
  opts: { kind: BackupMeta['kind']; source: Manifest['source']; actor: BackupMeta['createdBy']; progress?: Progress; id?: string },
): Promise<BackupMeta> {
  const { pool, store } = deps;
  const progress = opts.progress ?? (() => undefined);
  store.ensure();
  const now = new Date();
  let meta = store.newMeta(opts.kind, opts.actor, '', 'running');
  if (opts.id) meta.id = opts.id;
  meta = { ...meta, fileName: backupFileName(now, meta.id) };
  store.writeMeta(meta);
  const work = path.join(store.work, meta.id);
  const partial = `${store.archivePath(meta.id)}.partial`;
  let writer: TarWriter | null = null;
  try {
    progress('Checking free space');
    const est = await pool.query(
      `SELECT pg_database_size(current_database())::bigint::text AS db,
              COALESCE((SELECT sum(size_bytes) FROM attachments), 0)::bigint::text AS files`).catch(() => ({ rows: [{ db: '0', files: '0' }] }));
    const need = Number(est.rows[0].db) + Number(est.rows[0].files) * 1.05 + 64 * 1024 * 1024;
    const free = await freeBytes(store.root);
    if (free < need) throw new Error(`Not enough free disk space for a backup: about ${fmtBytes(need)} needed, ${fmtBytes(free)} free in ${store.root}. Delete old backups or add disk space.`);

    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    const c = await pool.connect();
    let schema: SchemaFile;
    const tables: ManifestTable[] = [];
    const totals: Manifest['totals'] = {};
    const counts: Record<string, number> = {};
    const attachmentRows: Array<{ id: string; project_id: string | null; stored_name: string; sha256: string; size_bytes: number }> = [];
    let projects: Manifest['summary']['projects'] = [];
    let serverVersion = '';
    try {
      // ---- consistent snapshot: writes are held only while the snapshot is being taken
      progress('Taking a consistent database snapshot');
      const snapshot = async () => {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        for (const s of SNAPSHOT_SETTINGS) await c.query(s);
        await c.query('SELECT txid_current_snapshot()'); // the snapshot is fixed by the first query
      };
      if (deps.ops) await deps.ops.freezeWrites(snapshot); else await snapshot();

      serverVersion = (await c.query('SHOW server_version')).rows[0].server_version;
      const described = await describeSchema(c, 'public', [...EXCLUDED_TABLES, MIGRATIONS_TABLE]);
      const migrations = (await c.query(`SELECT filename, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY filename`)).rows
        .map((r) => ({ filename: r.filename, checksum: r.checksum, applied_at: r.applied_at ? new Date(r.applied_at).toISOString() : null }));
      schema = { formatVersion: BACKUP_FORMAT_VERSION, tables: described, sequences: await listSequences(c, 'public'), migrations };

      let i = 0;
      for (const t of described) {
        progress(`Exporting ${t.name}`, ++i, described.length);
        const file = path.join(work, `${t.name}.ndjson.gz`);
        const onRow = t.name === 'attachments' ? (j: string) => { const r = JSON.parse(j); attachmentRows.push(r); } : undefined;
        const r = await exportTable(c, t.name, file, onRow);
        tables.push({ name: t.name, path: tableEntryPath(t.name), rows: r.rows, uncompressedBytes: r.uncompressedBytes });
        counts[t.name] = r.rows;
        const sums = await numericTotals(c, 'public', t.name, t.columns);
        if (sums) totals[t.name] = sums;
      }
      projects = (await c.query('SELECT id, code, name, archived_at FROM projects ORDER BY code')).rows
        .map((p) => ({ id: p.id, code: p.code, name: p.name, archived: !!p.archived_at }));
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }

    // ---- archive: README, schema, tables, files, manifest (last)
    writer = await TarWriter.create(partial);
    await writer.addBuffer('README.txt', Buffer.from(README));
    await writer.addBuffer('database/schema.json', Buffer.from(JSON.stringify(schema)));
    for (const t of tables) {
      const file = path.join(work, `${t.name}.ndjson.gz`);
      await writer.addFile(t.path, file, fs.statSync(file).size);
      fs.rmSync(file, { force: true });
    }
    const missing: Manifest['attachments']['missing'] = [];
    const mismatched: Manifest['attachments']['mismatched'] = [];
    const added = new Set<string>();
    let bytes = 0;
    let n = 0;
    for (const a of attachmentRows) {
      progress('Adding uploaded files', ++n, attachmentRows.length);
      const rel = attachmentRelPath(a);
      if (!rel) { missing.push({ id: a.id, path: String(a.stored_name) }); continue; }
      if (added.has(rel)) continue;
      const full = path.join(deps.uploadDir, rel);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { missing.push({ id: a.id, path: rel }); continue; }
      if (!st.isFile()) { missing.push({ id: a.id, path: rel }); continue; }
      const sha = await writer.addFile(`files/${rel}`, full, st.size);
      added.add(rel);
      bytes += st.size;
      if (sha !== a.sha256 || st.size !== Number(a.size_bytes)) mismatched.push({ id: a.id, path: rel });
    }
    const warnings: string[] = [];
    if (missing.length) warnings.push(`${missing.length} attachment file(s) are missing from storage and are NOT in this backup.`);
    if (mismatched.length) warnings.push(`${mismatched.length} attachment file(s) do not match their recorded checksum (already damaged in storage).`);
    const manifest: Manifest = {
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, backupId: meta.id, createdAt: now.toISOString(),
      createdBy: opts.actor, source: opts.source,
      app: { name: deps.app.name, version: deps.app.version, commit: deps.app.commit },
      schema: { latest: schema.migrations.at(-1)?.filename ?? null, migrations: schema.migrations.map((m) => m.filename) },
      postgres: { serverVersion },
      database: { tables, excludedTables: [...EXCLUDED_TABLES], sequences: schema.sequences.length },
      totals,
      summary: { counts, projects, users: counts.users ?? 0 },
      attachments: { rows: attachmentRows.length, filesIncluded: added.size, bytes, missing, mismatched },
      complete: missing.length === 0 && mismatched.length === 0,
      warnings, encryption: 'none',
      entries: [...writer.entries],
    };
    await writer.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 1)));
    const size = await writer.finish();
    writer = null;
    fs.renameSync(partial, store.archivePath(meta.id));

    // ---- verify the archive as written before reporting success
    progress('Verifying the archive');
    const report = await validateArchive(store.archivePath(meta.id), { app: deps.app, progress: (p, d, t) => progress(`Verifying: ${p}`, d, t) });
    if (!report.ok) throw new Error(`The new archive failed verification: ${report.errors.join('; ')}`);
    meta = {
      ...meta, status: manifest.complete ? 'verified' : 'incomplete', finishedAt: new Date().toISOString(), size,
      backupCreatedAt: manifest.createdAt, appVersion: manifest.app.version, commit: manifest.app.commit || null, schemaVersion: manifest.schema.latest,
      complete: manifest.complete, summary: manifest.summary,
      attachments: { rows: manifest.attachments.rows, filesIncluded: manifest.attachments.filesIncluded, bytes, missing: missing.length, mismatched: mismatched.length },
      warnings: [...warnings, ...report.warnings.filter((w) => !warnings.includes(w))], validation: report, error: null,
    };
    store.writeMeta(meta);
    return meta;
  } catch (e) {
    await writer?.abort();
    fs.rmSync(partial, { force: true });
    fs.rmSync(store.archivePath(meta.id), { force: true });
    meta = { ...meta, status: 'failed', finishedAt: new Date().toISOString(), error: (e as Error).message };
    store.writeMeta(meta);
    return meta;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
