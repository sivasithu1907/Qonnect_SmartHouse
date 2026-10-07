// Orchestrates backups, validation and restores for the web interface and the CLI: one
// operation at a time (in-process and across processes via a PostgreSQL advisory lock),
// progress reporting, maintenance mode, the pre-restore backup and audit events.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type pg from 'pg';
import { createBackup } from './create';
import { validateArchive, type ValidationReport } from './validate';
import { drainIdleConnections, PREVIOUS_RE, recoverInterruptedRestores, restoreArchive, type RestoreResult } from './restore';
import { BackupStore, freeBytes, type BackupMeta } from './store';
import { OpsState } from './ops';
import { qi, type AppInfo } from './format';

export const BACKUP_LOCK = 727003;      // one backup / restore at a time (web and CLI)
export const SCHEDULER_LOCK = 727002;   // held by a running due-date check (server/notify/scheduler.ts)
export const APP_RUNNING_LOCK = 727004; // held (shared) by every running web process

export type Actor = { id: string | null; email: string | null; name: string | null } | null;

export interface Operation {
  id: string;
  kind: 'backup' | 'validate' | 'restore';
  backupId: string | null;
  state: 'running' | 'succeeded' | 'failed';
  phase: string;
  done: number | null;
  total: number | null;
  startedAt: string;
  finishedAt: string | null;
  by: string | null;
  error: string | null;
  result: unknown;
}

export interface BackupServiceConfig {
  uploadDir: string;
  backupDir: string;
  backupRetention: number;
  backupMaxUploadBytes: number;
}

export class BusyError extends Error {}

export class BackupService {
  readonly store: BackupStore;
  current: Operation | null = null;
  last: Operation | null = null;

  constructor(private pool: pg.Pool, private cfg: BackupServiceConfig, readonly ops: OpsState, readonly app: AppInfo, private log: (m: string) => void = console.log) {
    this.store = new BackupStore(cfg.backupDir);
  }

  // ---------------------------------------------------------------- locking & progress
  private async acquire(): Promise<pg.PoolClient> {
    if (this.current?.state === 'running') throw new BusyError('Another backup or restore operation is already running.');
    const c = await this.pool.connect();
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [BACKUP_LOCK]);
    if (!rows[0].ok) {
      c.release();
      throw new BusyError('Another backup or restore operation is running (possibly from the command line).');
    }
    return c;
  }
  private async releaseLock(c: pg.PoolClient) {
    await c.query('SELECT pg_advisory_unlock($1)', [BACKUP_LOCK]).catch(() => undefined);
    c.release();
  }

  private newOp(kind: Operation['kind'], backupId: string | null, actor: Actor): Operation {
    return { id: crypto.randomUUID(), kind, backupId, state: 'running', phase: 'Starting', done: null, total: null, startedAt: new Date().toISOString(), finishedAt: null, by: actor?.email ?? null, error: null, result: null };
  }
  /** Optional listener (the CLI prints progress). */
  onProgress: ((phase: string, done?: number, total?: number) => void) | null = null;
  private progressOf(op: Operation, prefix = '') {
    return (phase: string, done?: number, total?: number) => {
      op.phase = prefix + phase; op.done = done ?? null; op.total = total ?? null;
      this.onProgress?.(prefix + phase, done, total);
    };
  }

  /** Runs `fn` as the single active operation. Resolves with the finished operation. */
  private async run(op: Operation, fn: (lock: pg.PoolClient) => Promise<unknown>): Promise<Operation> {
    const lock = await this.acquire();
    this.current = op;
    try {
      op.result = await fn(lock);
      op.state = 'succeeded';
    } catch (e) {
      op.state = 'failed';
      op.error = (e as Error).message;
    } finally {
      await this.releaseLock(lock);
      op.finishedAt = new Date().toISOString();
      op.phase = op.state === 'succeeded' ? 'Finished' : 'Failed';
      this.last = op;
      this.current = null;
    }
    return op;
  }

  /** Starts an operation in the background (web). Throws BusyError synchronously-ish if busy. */
  private async startBackground(op: Operation, fn: (lock: pg.PoolClient) => Promise<unknown>): Promise<Operation> {
    // take the lock first so a busy error is reported to the caller
    const lock = await this.acquire();
    this.current = op;
    void (async () => {
      try {
        op.result = await fn(lock);
        op.state = 'succeeded';
      } catch (e) {
        op.state = 'failed';
        op.error = (e as Error).message;
        this.log(`[backup] ${op.kind} failed: ${op.error}`);
      } finally {
        await this.releaseLock(lock);
        op.finishedAt = new Date().toISOString();
        op.phase = op.state === 'succeeded' ? 'Finished' : 'Failed';
        this.last = op;
        this.current = null;
      }
    })();
    return op;
  }

  async audit(actor: Actor, action: string, summary: string, after?: unknown, entityId?: string | null) {
    await this.pool.query(
      `INSERT INTO audit_log (project_id, user_id, user_email, action, entity_type, entity_id, summary, after)
       VALUES (NULL, $1, $2, $3, 'system_backup', $4, $5, $6)`,
      [actor?.id ?? null, actor?.email ?? null, action, entityId ?? null, summary, after === undefined ? null : JSON.stringify(after)],
    ).catch((e) => this.log(`[backup] audit failed: ${(e as Error).message}`));
  }

  // ---------------------------------------------------------------- startup
  /**
   * Finishes or undoes anything an interrupted process left behind. Skipped while another
   * process (e.g. a CLI backup) holds the backup lock, so its work files are never touched.
   */
  async recoverOnStartup(lockHeld = false) {
    const problem = this.store.writableProblem();
    if (problem) { this.log(`[backup] ${problem}`); return; }
    let lock: pg.PoolClient | null = null;
    if (!lockHeld) {
      lock = await this.pool.connect();
      const { rows } = await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [BACKUP_LOCK]);
      if (!rows[0].ok) { lock.release(); this.log('[backup] another backup / restore process is running; startup clean-up skipped'); return; }
    }
    try {
      this.store.cleanupStale();
      for (const m of this.store.list()) {
        if (m.status === 'running' || m.status === 'validating') {
          fs.rmSync(this.store.archivePath(m.id) + '.partial', { force: true });
          if (m.status === 'running') fs.rmSync(this.store.archivePath(m.id), { force: true });
          this.store.updateMeta(m.id, { status: m.status === 'running' ? 'failed' : 'uploaded', error: 'Interrupted: the application stopped during this operation.', finishedAt: new Date().toISOString() });
        }
      }
      const rec = await recoverInterruptedRestores(this.pool, this.store, this.cfg.uploadDir);
      for (const r of rec) {
        this.log(`[backup] interrupted restore ${r.restoreId}: ${r.outcome}`);
        this.ops.pauseJobs(r.outcome === 'committed'
          ? 'A restore finished but the application stopped before it completed its final steps. Complete the recovery checks, then resume background jobs.'
          : 'A restore was interrupted; the previous data was kept unchanged. Check the application, then resume background jobs.');
      }
      this.store.prune(this.cfg.backupRetention);
    } finally {
      if (lock) await this.releaseLock(lock);
    }
  }

  // ---------------------------------------------------------------- status
  async status() {
    let free: number | null = null;
    const problem = this.store.writableProblem();
    try { free = await freeBytes(this.cfg.backupDir); } catch { free = null; }
    const prev = await this.previousDatabase().catch(() => null);
    const current = await this.pool.query(
      `SELECT (SELECT count(*) FROM projects)::int AS projects, (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM attachments)::int AS attachments, (SELECT count(*) FROM payment_transactions)::int AS payment_transactions`,
    ).then((r) => r.rows[0] as Record<string, number>).catch(() => null);
    return {
      current,
      operation: this.current ?? this.last,
      maintenance: this.ops.maintenance,
      jobsPaused: this.ops.persisted.jobsPaused,
      pausedReason: this.ops.persisted.pausedReason,
      pausedAt: this.ops.persisted.pausedAt,
      lastRestore: this.ops.persisted.lastRestore,
      storage: { problem, freeBytes: free },
      limits: { maxUploadBytes: this.cfg.backupMaxUploadBytes, chunkBytes: CHUNK_BYTES, retention: this.cfg.backupRetention },
      app: { version: this.app.version, commit: this.app.commit, schema: this.app.migrations.at(-1)?.filename ?? null },
      previousDatabase: prev,
    };
  }

  async previousDatabase(): Promise<string | null> {
    const { rows } = await this.pool.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^pre_restore_[0-9]{8}_[0-9]{6}$' ORDER BY nspname DESC LIMIT 1`);
    return rows[0]?.nspname ?? null;
  }

  // ---------------------------------------------------------------- backup
  private async doBackup(progress: (p: string, d?: number, t?: number) => void, actor: Actor, kind: BackupMeta['kind'], useFreeze: boolean, id?: string): Promise<BackupMeta> {
    const meta = await createBackup(
      { pool: this.pool, uploadDir: this.cfg.uploadDir, store: this.store, ops: useFreeze ? this.ops : null, app: this.app },
      { kind, source: kind === 'pre_restore' ? 'pre_restore' : kind === 'cli' ? 'cli' : 'web', actor, progress, id },
    );
    if (meta.status === 'failed') {
      await this.audit(actor, 'backup_failed', `Backup failed: ${meta.error}`, { backupId: meta.id, kind }, meta.id);
      throw new Error(meta.error ?? 'Backup failed');
    }
    await this.audit(actor, 'backup_created',
      `${kind === 'pre_restore' ? 'Pre-restore backup' : 'Full backup'} created${meta.status === 'incomplete' ? ' — INCOMPLETE (files missing)' : ' and verified'} (${meta.fileName})`,
      { backupId: meta.id, kind, status: meta.status, size: meta.size, attachments: meta.attachments }, meta.id);
    if (kind !== 'pre_restore') this.store.prune(this.cfg.backupRetention);
    return meta;
  }

  async startBackup(actor: Actor): Promise<Operation> {
    const problem = this.store.writableProblem();
    if (problem) throw new Error(problem);
    const id = crypto.randomUUID();
    const op = this.newOp('backup', id, actor);
    return this.startBackground(op, () => this.doBackup(this.progressOf(op), actor, 'manual', true, id));
  }

  /** CLI: create a backup and wait for it. */
  async backupNow(actor: Actor, kind: BackupMeta['kind'] = 'cli'): Promise<BackupMeta> {
    const op = this.newOp('backup', crypto.randomUUID(), actor);
    const done = await this.run(op, () => this.doBackup(this.progressOf(op), actor, kind, false, op.backupId ?? undefined));
    if (done.state === 'failed') throw new Error(done.error ?? 'Backup failed');
    return done.result as BackupMeta;
  }

  // ---------------------------------------------------------------- validation
  async validateFile(file: string, progress?: (p: string, d?: number, t?: number) => void): Promise<ValidationReport> {
    return validateArchive(file, { app: this.app, maxBytes: this.cfg.backupMaxUploadBytes, progress });
  }

  private async doValidate(op: Operation, id: string, actor: Actor) {
    const meta = this.store.readMeta(id);
    if (!meta) throw new Error('Backup not found');
    const prevStatus = meta.status;
    this.store.updateMeta(id, { status: meta.kind === 'uploaded' ? 'validating' : meta.status });
    let report: ValidationReport;
    try {
      report = await this.validateFile(this.store.archivePath(id), this.progressOf(op));
    } catch (e) {
      this.store.updateMeta(id, { status: meta.kind === 'uploaded' ? 'invalid' : prevStatus, error: (e as Error).message });
      throw e;
    }
    const m = report.manifest;
    const status: BackupMeta['status'] = meta.kind === 'uploaded' ? (report.ok ? 'valid' : 'invalid') : (report.ok ? (m?.complete ? 'verified' : 'incomplete') : 'failed');
    const next = this.store.updateMeta(id, {
      status, validation: report, error: report.ok ? null : report.errors[0] ?? 'Validation failed',
      backupCreatedAt: m?.createdAt ?? meta.backupCreatedAt, appVersion: m?.app.version ?? meta.appVersion, commit: m?.app.commit || meta.commit,
      schemaVersion: m?.schemaLatest ?? meta.schemaVersion, complete: m?.complete ?? meta.complete, size: report.archiveBytes,
      summary: m ? { counts: report.counts, projects: report.projects, users: report.users } : meta.summary,
      attachments: report.attachments, warnings: report.warnings,
    });
    await this.audit(actor, 'backup_validated', `Backup archive ${meta.fileName} validated: ${report.ok ? 'valid' : 'REJECTED'}${report.ok ? '' : ` — ${report.errors[0]}`}`, { backupId: id, ok: report.ok, errors: report.errors.slice(0, 5) }, id);
    return next;
  }

  async startValidate(id: string, actor: Actor): Promise<Operation> {
    const op = this.newOp('validate', id, actor);
    return this.startBackground(op, () => this.doValidate(op, id, actor));
  }

  // ---------------------------------------------------------------- uploads
  async createUpload(fileName: string, size: number, actor: Actor) {
    if (!Number.isInteger(size) || size < 2048) throw new Error('The file is too small to be a backup archive.');
    if (size > this.cfg.backupMaxUploadBytes) throw new Error(`The file is larger than the maximum backup size (${Math.round(this.cfg.backupMaxUploadBytes / 1024 ** 2)} MB, BACKUP_MAX_UPLOAD_MB).`);
    const problem = this.store.writableProblem();
    if (problem) throw new Error(problem);
    const free = await freeBytes(this.cfg.backupDir);
    if (free < size + 256 * 1024 * 1024) throw new Error(`Not enough free disk space on the server for this upload (${Math.round(size / 1024 ** 2)} MB needed plus a margin, ${Math.round(free / 1024 ** 2)} MB free). Delete old backups first.`);
    return this.store.createUpload(fileName.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'backup.tar', size, actor?.id ?? '');
  }

  async completeUpload(uploadId: string, actor: Actor): Promise<{ meta: BackupMeta; op: Operation }> {
    const u = this.store.readUpload(uploadId);
    if (!u || u.by !== (actor?.id ?? '')) throw new Error('Upload not found');
    if (u.received !== u.size) throw new Error(`The upload is incomplete (${u.received} of ${u.size} bytes). Resume or start it again.`);
    const meta = this.store.newMeta('uploaded', actor, u.fileName, 'uploaded');
    meta.size = u.size;
    fs.renameSync(this.store.uploadPartPath(uploadId), this.store.archivePath(meta.id));
    this.store.removeUpload(uploadId);
    this.store.writeMeta(meta);
    await this.audit(actor, 'backup_uploaded', `Backup archive uploaded for validation: ${u.fileName} (${u.size} bytes)`, { backupId: meta.id }, meta.id);
    const op = await this.startValidate(meta.id, actor);
    return { meta, op };
  }

  // ---------------------------------------------------------------- restore
  private async hasInstallation(): Promise<{ migrated: boolean; users: number; projects: number }> {
    const { rows } = await this.pool.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS m, to_regclass('public.users') IS NOT NULL AS u, to_regclass('public.projects') IS NOT NULL AS p`);
    const users = rows[0].u ? Number((await this.pool.query('SELECT count(*)::int AS n FROM public.users')).rows[0].n) : 0;
    const projects = rows[0].p ? Number((await this.pool.query('SELECT count(*)::int AS n FROM public.projects')).rows[0].n) : 0;
    return { migrated: rows[0].m, users, projects };
  }

  private async doRestore(
    op: Operation, lock: pg.PoolClient, file: string, actor: Actor,
    o: { backupId: string | null; preBackup: boolean; maintenance: boolean; testFailAt?: 'before_swap' | 'during_files' },
  ): Promise<RestoreResult & { preRestoreBackupId: string | null }> {
    const progress = this.progressOf(op);
    progress('Validating the archive');
    const report = await this.validateFile(file, progress);
    if (!report.ok) throw new Error(`The archive was rejected before any change: ${report.errors.slice(0, 3).join('; ')}`);
    const before = this.ops.persisted;
    const restoreId = op.id;
    this.ops.pauseJobs('Restore in progress');
    let maintenanceEntered = false;
    let schedulerLocked = false;
    try {
      progress('Pausing background jobs');
      await lock.query(`SET statement_timeout = '120s'`);
      await lock.query('SELECT pg_advisory_lock($1)', [SCHEDULER_LOCK]); // waits for a running due-date check to finish
      schedulerLocked = true;
      await lock.query('SET statement_timeout = 0');
      if (o.maintenance) {
        progress('Entering maintenance mode');
        await this.ops.enterMaintenance('Qonnect is being restored from a backup. Please wait — this page will work again when the restore has finished.');
        maintenanceEntered = true;
      }
      const inst = await this.hasInstallation();
      if (inst.migrated) await this.audit(actor, 'restore_started', `Full restore started from backup of ${report.manifest?.createdAt}`, { restoreId, backupId: report.manifest?.backupId }, restoreId);
      let preId: string | null = null;
      if (o.preBackup && inst.migrated) {
        progress('Creating a safety backup of the current data');
        try {
          const meta = await this.doBackup(this.progressOf(op, 'Safety backup: '), actor, 'pre_restore', false);
          preId = meta.id;
        } catch (e) {
          throw new Error(`The safety backup of the current data failed, so nothing was restored: ${(e as Error).message}`);
        }
      }
      const result = await restoreArchive(
        { pool: this.pool, uploadDir: this.cfg.uploadDir, store: this.store, app: this.app }, file,
        { restoreId, actor, report, progress, testFailAt: o.testFailAt },
      );
      await drainIdleConnections(this.pool);
      this.ops.update({
        jobsPaused: true,
        pausedReason: 'Restored from a backup. Background jobs and notifications stay paused until an administrator completes the recovery checks and resumes them.',
        pausedAt: new Date().toISOString(),
        lastRestore: { id: restoreId, at: new Date().toISOString(), backupCreatedAt: result.backupCreatedAt, by: actor?.email ?? null },
      });
      if (o.backupId) { try { this.store.updateMeta(o.backupId, { restoredAt: new Date().toISOString() }); } catch { /* metadata only */ } }
      return { ...result, preRestoreBackupId: preId };
    } catch (e) {
      this.ops.update({ jobsPaused: before.jobsPaused, pausedReason: before.pausedReason, pausedAt: before.pausedAt });
      await this.audit(actor, 'restore_failed', `Restore failed; the existing data was kept unchanged: ${(e as Error).message}`, { restoreId }, restoreId);
      throw e;
    } finally {
      if (schedulerLocked) await lock.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK]).catch(() => undefined);
      if (maintenanceEntered) this.ops.exitMaintenance();
    }
  }

  async startRestore(backupId: string, actor: Actor, opts: { testFailAt?: 'before_swap' | 'during_files' } = {}): Promise<Operation> {
    const meta = this.store.readMeta(backupId);
    if (!meta) throw new Error('Backup not found');
    if (!['verified', 'incomplete', 'valid'].includes(meta.status)) throw new Error('Only a verified or validated backup can be restored. Validate the archive first.');
    if (!fs.existsSync(this.store.archivePath(backupId))) throw new Error('The archive file is no longer on the server.');
    const op = this.newOp('restore', backupId, actor);
    return this.startBackground(op, (lock) => this.doRestore(op, lock, this.store.archivePath(backupId), actor, { backupId, preBackup: true, maintenance: true, ...opts }));
  }

  /** CLI restore (the web application must be stopped). */
  async restoreNow(file: string, actor: Actor, opts: { preBackup: boolean; replaceExisting: boolean }) {
    const probe = await this.pool.connect();
    try {
      const { rows } = await probe.query('SELECT pg_try_advisory_lock($1) AS ok', [APP_RUNNING_LOCK]);
      if (!rows[0].ok) throw new Error('The web application is still running. Stop it first: docker compose stop app');
      const inst = await this.hasInstallation();
      if ((inst.users > 0 || inst.projects > 0) && !opts.replaceExisting) {
        throw new Error(`This installation already has data (${inst.projects} projects, ${inst.users} users). Add --replace-existing to replace it (a safety backup is made first).`);
      }
      const op = this.newOp('restore', null, actor);
      const done = await this.run(op, async (lock) => {
        await this.recoverOnStartup(true); // the app is stopped and we hold the lock: finish / undo anything interrupted first
        return this.doRestore(op, lock, file, actor, { backupId: null, preBackup: opts.preBackup, maintenance: false });
      });
      if (done.state === 'failed') throw new Error(done.error ?? 'Restore failed');
      return done.result as RestoreResult & { preRestoreBackupId: string | null };
    } finally {
      await probe.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      probe.release();
    }
  }

  // ---------------------------------------------------------------- after recovery
  async resumeJobs(actor: Actor) {
    this.ops.resumeJobs();
    await this.audit(actor, 'jobs_resumed', 'Background jobs and notifications resumed after recovery checks');
  }

  /** CLI: the previous data kept by the last restore — swap back to it, or drop it. */
  async previousDb(action: 'status' | 'rollback' | 'discard', actor: Actor): Promise<string> {
    const prev = await this.previousDatabase();
    if (action === 'status') return prev ? `Previous data from before the last restore is kept as schema ${prev}.` : 'No previous data is kept.';
    if (!prev || !PREVIOUS_RE.test(prev)) throw new Error('No previous data is kept.');
    const c = await this.pool.connect();
    try {
      if (action === 'rollback') {
        const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [APP_RUNNING_LOCK]);
        if (!rows[0].ok) throw new Error('The web application is still running. Stop it first: docker compose stop app');
      }
      await c.query('BEGIN');
      if (action === 'discard') {
        await c.query(`DROP SCHEMA ${qi(prev)} CASCADE`);
        await c.query('COMMIT');
        await this.audit(actor, 'restore_previous_discarded', `Discarded previous data ${prev}`);
        return `Dropped ${prev}.`;
      }
      const { rows: exts } = await c.query(`SELECT e.extname, e.extrelocatable FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = 'public'`);
      for (const x of exts) {
        if (!x.extrelocatable) continue;
        await c.query('SAVEPOINT ext');
        try { await c.query(`ALTER EXTENSION ${qi(x.extname)} SET SCHEMA ${qi(prev)}`); await c.query('RELEASE SAVEPOINT ext'); }
        catch { await c.query('ROLLBACK TO SAVEPOINT ext'); }
      }
      const stampNow = () => `pre_restore_${new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}`;
      let parked = stampNow();
      if (parked === prev) { await new Promise((r) => setTimeout(r, 1100)); parked = stampNow(); }
      await c.query(`ALTER SCHEMA public RENAME TO ${qi(parked)}`);
      await c.query(`ALTER SCHEMA ${qi(prev)} RENAME TO public`);
      await c.query('DELETE FROM public.sessions');
      await c.query('COMMIT');
      await this.audit(actor, 'restore_rolled_back', `Switched back to the data from before the last restore (${prev}); the restored data is kept as ${parked}`);
      this.ops.pauseJobs('Switched back to the data from before the last restore. Check the application, then resume background jobs.');
      return `Switched back to ${prev}. The restored data is kept as ${parked}. All users must sign in again.`;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      c.release();
    }
  }

  removeBackup(id: string) {
    const m = this.store.readMeta(id);
    if (!m) throw new Error('Backup not found');
    if (this.current?.backupId === id) throw new BusyError('This backup is in use by the running operation.');
    this.store.remove(id);
    return m;
  }
}

export const CHUNK_BYTES = 8 * 1024 * 1024;

/** Reads the application version (package.json) and commit (APP_COMMIT, set from APP_TAG by Compose). */
export function readAppInfo(migrationsDir: string, readMigrations: (d: string) => AppInfo['migrations']): AppInfo {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version ?? version; } catch { /* not available */ }
  const commit = (process.env.APP_COMMIT ?? '').trim();
  return { name: 'qonnect-smart-house', version, commit: commit === 'latest' ? '' : commit, migrations: readMigrations(migrationsDir) };
}
