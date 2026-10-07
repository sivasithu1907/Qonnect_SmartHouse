// Private storage for backup archives, their metadata, chunked uploads and restore journals.
// Everything lives under BACKUP_DIR, which is separate from UPLOAD_DIR and never served
// statically. Archive paths are derived only from validated ids, so deleting an archive can
// never touch live attachments.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Manifest } from './format';
import type { ValidationReport } from './validate';

export type BackupKind = 'manual' | 'cli' | 'pre_restore' | 'uploaded';
export type BackupStatus = 'running' | 'verified' | 'incomplete' | 'failed' | 'uploaded' | 'validating' | 'valid' | 'invalid';

export interface BackupMeta {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  createdAt: string;
  finishedAt: string | null;
  createdBy: { id: string | null; email: string | null; name: string | null } | null;
  fileName: string;
  size: number | null;
  /** from the archive manifest */
  backupCreatedAt: string | null;
  appVersion: string | null;
  commit: string | null;
  schemaVersion: string | null;
  complete: boolean | null;
  summary: Manifest['summary'] | null;
  attachments: { rows: number; filesIncluded: number; bytes: number; missing: number; mismatched: number } | null;
  error: string | null;
  warnings: string[];
  validation: ValidationReport | null;
  restoredAt: string | null;
}

export interface UploadSession { id: string; fileName: string; size: number; received: number; createdAt: string; by: string }

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

export class BackupStore {
  readonly archives: string;
  readonly meta: string;
  readonly incoming: string;
  readonly work: string;
  readonly journal: string;

  constructor(readonly root: string) {
    this.archives = path.join(root, 'archives');
    this.meta = path.join(root, 'meta');
    this.incoming = path.join(root, 'incoming');
    this.work = path.join(root, 'work');
    this.journal = path.join(root, 'journal');
  }

  get opsStateFile() { return path.join(this.root, 'ops-state.json'); }

  ensure() {
    for (const d of [this.root, this.archives, this.meta, this.incoming, this.work, this.journal]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  /** null when writable, otherwise a readable problem description */
  writableProblem(): string | null {
    try {
      this.ensure();
      const probe = path.join(this.root, `.probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return null;
    } catch (e) {
      return `Backup storage ${this.root} is not writable (${(e as Error).message}).`;
    }
  }

  archivePath(id: string) {
    if (!isId(id)) throw new Error('Invalid backup id');
    return path.join(this.archives, `${id}.tar`);
  }
  private metaPath(id: string) {
    if (!isId(id)) throw new Error('Invalid backup id');
    return path.join(this.meta, `${id}.json`);
  }

  writeMeta(m: BackupMeta) {
    const p = this.metaPath(m.id);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(m, null, 2), { mode: 0o600 });
    fs.renameSync(`${p}.tmp`, p);
  }
  readMeta(id: string): BackupMeta | null {
    try { return JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8')) as BackupMeta; } catch { return null; }
  }
  updateMeta(id: string, patch: Partial<BackupMeta>): BackupMeta {
    const m = this.readMeta(id);
    if (!m) throw new Error('Backup not found');
    const next = { ...m, ...patch };
    this.writeMeta(next);
    return next;
  }
  list(): BackupMeta[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.meta); } catch { return []; }
    return names.filter((n) => n.endsWith('.json') && isId(n.slice(0, -5)))
      .map((n) => this.readMeta(n.slice(0, -5)))
      .filter((m): m is BackupMeta => !!m)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Deletes one archive and its metadata (only files inside BACKUP_DIR/archives and /meta). */
  remove(id: string) {
    fs.rmSync(this.archivePath(id), { force: true });
    fs.rmSync(`${this.archivePath(id)}.partial`, { force: true });
    fs.rmSync(this.metaPath(id), { force: true });
  }

  newMeta(kind: BackupKind, by: BackupMeta['createdBy'], fileName: string, status: BackupStatus): BackupMeta {
    return {
      id: crypto.randomUUID(), kind, status, createdAt: new Date().toISOString(), finishedAt: null, createdBy: by, fileName, size: null,
      backupCreatedAt: null, appVersion: null, commit: null, schemaVersion: null, complete: null, summary: null, attachments: null,
      error: null, warnings: [], validation: null, restoredAt: null,
    };
  }

  /**
   * Bounded retention: keeps the newest `keep` successful backups of each kind (pre-restore
   * backups: 3, uploaded archives: 5) and failed records for 30 days.
   */
  prune(keep: number) {
    const all = this.list();
    const limits: Record<BackupKind, number> = { manual: keep, cli: keep, pre_restore: 3, uploaded: 5 };
    const counts: Record<string, number> = {};
    const now = Date.now();
    const removed: string[] = [];
    for (const m of all) {
      if (m.status === 'running' || m.status === 'validating') continue;
      if (m.status === 'failed' || m.status === 'invalid') {
        if (now - new Date(m.createdAt).getTime() > 30 * 86400_000) { this.remove(m.id); removed.push(m.id); }
        else fs.rmSync(this.archivePath(m.id), { force: true }); // nothing worth keeping in a failed archive
        continue;
      }
      const bucket = m.kind === 'cli' ? 'manual' : m.kind;
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      if (counts[bucket] > limits[m.kind]) { this.remove(m.id); removed.push(m.id); }
    }
    return removed;
  }

  // ---- chunked uploads
  private uploadMetaPath(id: string) {
    if (!isId(id)) throw new Error('Invalid upload id');
    return path.join(this.incoming, `${id}.json`);
  }
  uploadPartPath(id: string) {
    if (!isId(id)) throw new Error('Invalid upload id');
    return path.join(this.incoming, `${id}.part`);
  }
  createUpload(fileName: string, size: number, by: string): UploadSession {
    const u: UploadSession = { id: crypto.randomUUID(), fileName, size, received: 0, createdAt: new Date().toISOString(), by };
    fs.writeFileSync(this.uploadPartPath(u.id), Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(this.uploadMetaPath(u.id), JSON.stringify(u), { mode: 0o600 });
    return u;
  }
  readUpload(id: string): UploadSession | null {
    try {
      const u = JSON.parse(fs.readFileSync(this.uploadMetaPath(id), 'utf8')) as UploadSession;
      u.received = fs.statSync(this.uploadPartPath(id)).size;
      return u;
    } catch { return null; }
  }
  removeUpload(id: string) {
    fs.rmSync(this.uploadPartPath(id), { force: true });
    fs.rmSync(this.uploadMetaPath(id), { force: true });
  }

  /** Removes work folders, interrupted uploads older than 24 h and stray partial archives. */
  cleanupStale() {
    fs.rmSync(this.work, { recursive: true, force: true });
    fs.mkdirSync(this.work, { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (const n of fs.readdirSync(this.incoming)) {
      const id = n.split('.')[0];
      if (!isId(id)) continue;
      const u = this.readUpload(id);
      if (!u || now - new Date(u.createdAt).getTime() > 24 * 3600_000) this.removeUpload(id);
    }
    for (const n of fs.readdirSync(this.archives)) if (n.endsWith('.partial')) fs.rmSync(path.join(this.archives, n), { force: true });
    // finished restore journals are kept for 30 days for reference
    for (const n of fs.readdirSync(this.journal)) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.journal, n), 'utf8'));
        if (j.state !== 'running' && now - new Date(j.startedAt).getTime() > 30 * 86400_000) {
          fs.rmSync(path.join(this.journal, n), { force: true });
          fs.rmSync(path.join(this.journal, `${id}.files`), { force: true });
        }
      } catch { /* unreadable: leave for inspection */ }
    }
  }
}

/** Free bytes on the file system holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}
