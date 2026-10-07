// Read-only validation of a backup archive. Uploaded archives are untrusted: nothing in them is
// executed, no path from them is used on disk, and decompression is bounded.
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import {
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, EXCLUDED_TABLES, FILE_DIR_RE, FILE_NAME_RE, MIGRATIONS_TABLE, TABLE_NAME_RE, attachmentRelPath, tableEntryPath,
  type AppInfo, type Manifest, type SchemaFile,
} from './format';
import { entryStream, readEntryBuffer, readTar, type TarEntry } from './tar';
import type { Progress } from './create';

export interface Compatibility {
  compatible: boolean;
  status: 'same' | 'older' | 'newer' | 'different' | 'unknown';
  pendingMigrations: string[];
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  checkedAt: string;
  archiveBytes: number;
  manifest: null | {
    backupId: string; createdAt: string; createdBy: Manifest['createdBy']; source: string; formatVersion: number;
    app: Manifest['app']; schemaLatest: string | null; postgres: string; complete: boolean; encryption: string;
  };
  compatibility: Compatibility;
  counts: Record<string, number>;
  projects: Manifest['summary']['projects'];
  users: number;
  tables: number;
  attachments: { rows: number; filesIncluded: number; bytes: number; missing: number; mismatched: number };
}

const MAX_JSON_ENTRY = 64 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
export const DEFAULT_MAX_UNCOMPRESSED = 64 * 1024 ** 3;

export function checkCompatibility(backupMigrations: string[], app: AppInfo): Compatibility {
  const appNames = app.migrations.map((m) => m.filename);
  const unknown = backupMigrations.filter((m) => !appNames.includes(m));
  if (unknown.length) {
    return { compatible: false, status: 'newer', pendingMigrations: [], message: `This backup was made by a newer version of the application (database change ${unknown[0]} is unknown here). Install that version or newer from GitHub, then restore.` };
  }
  const prefixOk = backupMigrations.every((m, i) => appNames[i] === m);
  if (!prefixOk) {
    return { compatible: false, status: 'different', pendingMigrations: [], message: 'The backup\'s database changes do not match this application\'s migration history. Restore it with the application version that created it.' };
  }
  if (!backupMigrations.length) return { compatible: false, status: 'unknown', pendingMigrations: [], message: 'The backup does not record any database version.' };
  const pending = appNames.slice(backupMigrations.length);
  return pending.length
    ? { compatible: true, status: 'older', pendingMigrations: pending, message: `Compatible. The backup is from an older database version; ${pending.length} newer database change(s) will be applied after restoring (${pending.join(', ')}).` }
    : { compatible: true, status: 'same', pendingMigrations: [], message: 'Compatible: same database version as this application.' };
}

/** Streams a gzip NDJSON entry: hashes the compressed bytes and yields each decompressed line. */
export async function scanNdjson(file: string, e: TarEntry, budget: { left: number }, onLine: (line: string) => void | Promise<void>): Promise<string> {
  const hash = crypto.createHash('sha256');
  const src = entryStream(file, e);
  src.on('data', (b: Buffer) => hash.update(b));
  const gunzip = zlib.createGunzip();
  src.pipe(gunzip);
  const dec = new StringDecoder('utf8');
  let carry = '';
  try {
    for await (const chunk of gunzip) {
      const b = chunk as Buffer;
      budget.left -= b.length;
      if (budget.left < 0) throw new Error('The archive expands to more data than allowed (possible decompression bomb)');
      const text = carry + dec.write(b);
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      if (carry.length > MAX_LINE) throw new Error(`${e.name}: a row is larger than allowed`);
      for (const p of parts) await onLine(p);
    }
  } catch (err) {
    src.destroy();
    const code = String((err as { code?: string }).code ?? '');
    if (code.startsWith('Z_')) throw new Error(`${e.name} is not readable (corrupt compressed data)`);
    throw err;
  }
  carry += dec.end();
  if (carry.length) throw new Error(`${e.name} is truncated (last row incomplete)`);
  return hash.digest('hex');
}

async function hashEntry(file: string, e: TarEntry): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const b of entryStream(file, e)) hash.update(b as Buffer);
  return hash.digest('hex');
}

const emptyReport = (archiveBytes: number): ValidationReport => ({
  ok: false, errors: [], warnings: [], checkedAt: new Date().toISOString(), archiveBytes, manifest: null,
  compatibility: { compatible: false, status: 'unknown', pendingMigrations: [], message: 'Not checked' },
  counts: {}, projects: [], users: 0, tables: 0, attachments: { rows: 0, filesIncluded: 0, bytes: 0, missing: 0, mismatched: 0 },
});

export async function validateArchive(file: string, opts: { app: AppInfo; maxBytes?: number; maxUncompressedBytes?: number; progress?: Progress }): Promise<ValidationReport> {
  const progress = opts.progress ?? (() => undefined);
  const size = fs.statSync(file).size;
  const rep = emptyReport(size);
  const err = (m: string) => { if (rep.errors.length < 50) rep.errors.push(m); };
  if (size < 2048) { err('The file is too small to be a backup archive.'); return rep; }
  if (opts.maxBytes && size > opts.maxBytes) { err('The file is larger than the configured maximum backup size.'); return rep; }

  const actual = new Map<string, { size: number; sha256: string }>();
  const tableRows = new Map<string, number>();
  const refs: Array<{ id: string; rel: string | null; sha256: string; stored: string }> = [];
  let schema: SchemaFile | null = null;
  let manifest: Manifest | null = null;
  const budget = { left: opts.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED };
  let stage: 'start' | 'tables' | 'files' | 'end' = 'start';
  let entries = 0;

  try {
    for await (const e of readTar(file)) {
      entries++;
      if (stage === 'end') throw new Error('The archive has entries after its manifest.');
      if (e.name === 'README.txt') {
        if (stage !== 'start') throw new Error('Unexpected entry order (README.txt)');
        actual.set(e.name, { size: e.size, sha256: await hashEntry(file, e) });
      } else if (e.name === 'database/schema.json') {
        if (stage !== 'start') throw new Error('Unexpected entry order (schema.json)');
        const buf = await readEntryBuffer(file, e, MAX_JSON_ENTRY);
        actual.set(e.name, { size: e.size, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
        try { schema = JSON.parse(buf.toString('utf8')) as SchemaFile; } catch { throw new Error('database/schema.json is not readable'); }
        if (!Array.isArray(schema?.tables) || !Array.isArray(schema?.migrations) || !Array.isArray(schema?.sequences)) throw new Error('database/schema.json is incomplete');
        for (const t of schema.tables) {
          if (!TABLE_NAME_RE.test(String(t?.name)) || !Array.isArray(t.columns) || !t.columns.length) throw new Error('database/schema.json lists an invalid table');
          if ((EXCLUDED_TABLES as readonly string[]).includes(t.name) || t.name === MIGRATIONS_TABLE) throw new Error(`The archive unexpectedly contains ${t.name}`);
        }
        stage = 'tables';
      } else if (e.name.startsWith('database/tables/')) {
        if (stage !== 'tables' || !schema) throw new Error('Unexpected entry order (table data before schema)');
        const m = /^database\/tables\/([a-z_][a-z0-9_]{0,62})\.ndjson\.gz$/.exec(e.name);
        const def = m && schema.tables.find((t) => t.name === m[1]);
        if (!m || !def) throw new Error(`Unexpected table entry ${e.name}`);
        progress(`Checking ${def.name}`, tableRows.size + 1, schema.tables.length);
        const cols = new Set(def.columns.map((c) => c.name));
        let rows = 0;
        const sha = await scanNdjson(file, e, budget, (line) => {
          let obj: Record<string, unknown>;
          try { obj = JSON.parse(line); } catch { throw new Error(`${def.name}: row ${rows + 1} is not readable`); }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${def.name}: row ${rows + 1} is not a record`);
          const keys = Object.keys(obj);
          if (keys.length !== cols.size || keys.some((k) => !cols.has(k))) throw new Error(`${def.name}: row ${rows + 1} does not match the table's columns`);
          rows++;
          if (def.name === 'attachments') {
            const a = obj as { id: string; project_id: string | null; stored_name: string; sha256: string };
            refs.push({ id: String(a.id), rel: attachmentRelPath(a), sha256: String(a.sha256), stored: String(a.stored_name) });
          }
        });
        actual.set(e.name, { size: e.size, sha256: sha });
        tableRows.set(def.name, rows);
      } else if (e.name.startsWith('files/')) {
        if (stage === 'start') throw new Error('Unexpected entry order (files before database)');
        stage = 'files';
        const [, dir, name, ...rest] = e.name.split('/');
        if (rest.length || !FILE_DIR_RE.test(dir ?? '') || !FILE_NAME_RE.test(name ?? '')) throw new Error(`Unexpected file entry ${e.name}`);
        if (actual.size % 50 === 0) progress('Checking uploaded files');
        actual.set(e.name, { size: e.size, sha256: await hashEntry(file, e) });
      } else if (e.name === 'manifest.json') {
        const buf = await readEntryBuffer(file, e, MAX_JSON_ENTRY);
        try { manifest = JSON.parse(buf.toString('utf8')) as Manifest; } catch { throw new Error('manifest.json is not readable'); }
        stage = 'end';
      } else {
        throw new Error(`Unexpected entry ${e.name}`);
      }
    }
  } catch (e) {
    err((e as Error).message);
    return rep;
  }
  if (!entries) { err('The archive is empty.'); return rep; }
  if (!manifest) { err('The archive has no manifest.json (it is incomplete or not a Qonnect backup).'); return rep; }
  if (!schema) { err('The archive has no database/schema.json.'); return rep; }
  const m: Manifest = manifest;
  if (m.format !== BACKUP_FORMAT) { err('This is not a Qonnect Smart House backup.'); return rep; }
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) { err(`Unsupported backup format version ${m.formatVersion} (this application reads version ${BACKUP_FORMAT_VERSION}).`); return rep; }
  if (!Array.isArray(m.entries) || !Array.isArray(m.database?.tables) || !m.attachments || !m.schema) { err('manifest.json is incomplete'); return rep; }

  rep.manifest = {
    backupId: String(m.backupId), createdAt: String(m.createdAt), createdBy: m.createdBy ?? null, source: String(m.source), formatVersion: m.formatVersion,
    app: m.app, schemaLatest: m.schema.latest, postgres: m.postgres?.serverVersion ?? '', complete: !!m.complete, encryption: String(m.encryption),
  };
  rep.counts = m.summary?.counts ?? {};
  rep.projects = Array.isArray(m.summary?.projects) ? m.summary.projects : [];
  rep.users = m.summary?.users ?? 0;
  rep.tables = schema.tables.length;

  // ---- checksums: every listed entry present with the same size and SHA-256, nothing extra
  const listed = new Set<string>();
  for (const le of m.entries) {
    listed.add(le.path);
    const a = actual.get(le.path);
    if (!a) err(`Missing from the archive: ${le.path}`);
    else if (a.size !== le.size || a.sha256 !== le.sha256) err(`Checksum mismatch (corrupt or modified): ${le.path}`);
  }
  for (const p of actual.keys()) if (!listed.has(p)) err(`Not listed in the manifest: ${p}`);

  // ---- database tables
  const schemaNames = new Set(schema.tables.map((t) => t.name));
  for (const t of m.database.tables) {
    if (!schemaNames.has(t.name)) err(`Manifest table ${t.name} is not in the schema`);
    if (t.path !== tableEntryPath(t.name)) err(`Manifest table ${t.name} has an unexpected path`);
    const got = tableRows.get(t.name);
    if (got === undefined) err(`Table data missing: ${t.name}`);
    else if (got !== t.rows) err(`Row count mismatch for ${t.name}: manifest ${t.rows}, archive ${got}`);
  }
  for (const n of schemaNames) if (!m.database.tables.some((t) => t.name === n)) err(`Table ${n} is missing from the manifest`);
  const schemaMigrations = schema.migrations.map((x) => x.filename);
  if (JSON.stringify(schemaMigrations) !== JSON.stringify(m.schema.migrations)) err('The manifest and schema list different database versions');

  // ---- attachments ↔ files
  const missingIds = new Set(m.attachments.missing.map((x) => x.id));
  const mismatchedIds = new Set(m.attachments.mismatched.map((x) => x.id));
  const referenced = new Set<string>();
  let filesIncluded = 0;
  let bytes = 0;
  for (const r of refs) {
    if (!r.rel) { if (!missingIds.has(r.id)) err(`Attachment ${r.id} has an invalid stored file name`); continue; }
    referenced.add(`files/${r.rel}`);
    const f = actual.get(`files/${r.rel}`);
    if (!f) { if (!missingIds.has(r.id)) err(`Attachment file missing from the archive: ${r.rel}`); continue; }
    if (f.sha256 !== r.sha256 && !mismatchedIds.has(r.id)) err(`Attachment file does not match its record checksum: ${r.rel}`);
  }
  for (const [p, f] of actual) {
    if (!p.startsWith('files/')) continue;
    filesIncluded++;
    bytes += f.size;
    if (!referenced.has(p)) rep.warnings.push(`File not referenced by any attachment record: ${p}`);
  }
  if (refs.length !== (tableRows.get('attachments') ?? 0)) err('Attachment rows could not be checked');
  if (m.complete && (missingIds.size || mismatchedIds.size)) err('The manifest claims a complete backup but lists missing files');
  rep.attachments = { rows: refs.length, filesIncluded, bytes, missing: missingIds.size, mismatched: mismatchedIds.size };
  if (missingIds.size) rep.warnings.push(`INCOMPLETE BACKUP: ${missingIds.size} attachment file(s) were missing when the backup was made and cannot be restored. Their records will be restored without the file.`);
  if (mismatchedIds.size) rep.warnings.push(`${mismatchedIds.size} attachment file(s) were already damaged (checksum mismatch) when the backup was made.`);

  // ---- compatibility with this application
  rep.compatibility = checkCompatibility(m.schema.migrations, opts.app);
  if (!rep.compatibility.compatible) err(rep.compatibility.message);
  for (const sm of schema.migrations) {
    const local = opts.app.migrations.find((x) => x.filename === sm.filename);
    if (local && local.checksum !== sm.checksum) rep.warnings.push(`Migration ${sm.filename} differs from this application's copy (content changed). The restore re-checks every table and column.`);
  }
  if (m.encryption !== 'none') err(`Unsupported encryption setting "${m.encryption}"`);

  rep.ok = rep.errors.length === 0;
  return rep;
}
