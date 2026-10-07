// Operational state of one installation: maintenance mode (during a restore), a brief write
// freeze (while a backup snapshot is taken) and the persistent "background jobs paused" flag
// (set by a restore and cleared only by an administrator after recovery checks).
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

export interface PersistedOpsState {
  jobsPaused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  lastRestore: { id: string; at: string; backupCreatedAt: string | null; by: string | null } | null;
}

const DEFAULT_STATE: PersistedOpsState = { jobsPaused: false, pausedReason: null, pausedAt: null, lastRestore: null };

/** Requests that keep working during maintenance (status polling and the health check). */
const MAINTENANCE_ALLOWED = [/^\/api\/health$/, /^\/api\/system\/status$/, /^\/api\/admin\/backup\/status$/, /^\/api\/auth\/me$/];
/** Backup routes are not counted as in-flight requests (they start the snapshot / restore themselves). */
const NOT_COUNTED = /^\/api\/admin\/backup\//;

export class OpsState {
  private state: PersistedOpsState;
  private maintenanceMsg: string | null = null;
  private frozen: Promise<void> | null = null;
  private inflight = 0;
  private inflightWrites = 0;
  private waiters: Array<() => void> = [];

  constructor(private stateFile: string | null) {
    this.state = { ...DEFAULT_STATE };
    if (stateFile) {
      try {
        this.state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
      } catch { /* first start or unreadable: defaults */ }
    }
  }

  get persisted(): PersistedOpsState { return { ...this.state }; }
  get jobsPaused(): boolean { return this.state.jobsPaused || this.maintenanceMsg !== null; }
  get maintenance(): string | null { return this.maintenanceMsg; }

  update(patch: Partial<PersistedOpsState>) {
    this.state = { ...this.state, ...patch };
    if (this.stateFile) {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    }
  }

  pauseJobs(reason: string) { this.update({ jobsPaused: true, pausedReason: reason, pausedAt: new Date().toISOString() }); }
  resumeJobs() { this.update({ jobsPaused: false, pausedReason: null, pausedAt: null }); }

  private notify() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
  private async waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (!cond()) {
      const left = end - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
    return true;
  }

  /** Rejects new API requests (except status polling) and waits for in-flight ones to finish. */
  async enterMaintenance(message: string, drainTimeoutMs = 30_000) {
    this.maintenanceMsg = message;
    const drained = await this.waitFor(() => this.inflight === 0, drainTimeoutMs);
    if (!drained) {
      this.maintenanceMsg = null;
      throw new Error('Requests are still running after 30 seconds. Nothing was changed; try again in a moment.');
    }
  }
  exitMaintenance() { this.maintenanceMsg = null; }

  /**
   * Holds new write requests, waits for running ones to finish, runs `fn` (which takes the
   * database snapshot) and releases the writes again. Reads are never blocked.
   */
  async freezeWrites<T>(fn: () => Promise<T>, drainTimeoutMs = 15_000): Promise<T> {
    if (this.frozen) throw new Error('A snapshot is already being taken');
    let release!: () => void;
    this.frozen = new Promise<void>((r) => { release = r; });
    try {
      const drained = await this.waitFor(() => this.inflightWrites === 0, drainTimeoutMs);
      if (!drained) throw new Error('The application is busy saving changes. Try the backup again in a moment.');
      return await fn();
    } finally {
      this.frozen = null;
      release();
    }
  }

  /** Express middleware for /api: maintenance gate, write freeze and in-flight tracking. */
  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const url = req.originalUrl.split('?')[0];
      const allowed = MAINTENANCE_ALLOWED.some((r) => r.test(url));
      if (this.maintenanceMsg && !allowed) {
        res.setHeader('Retry-After', '30');
        return res.status(503).json({ error: this.maintenanceMsg, maintenance: true });
      }
      const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !NOT_COUNTED.test(url);
      if (isWrite && this.frozen) {
        const ok = await Promise.race([this.frozen.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20_000))]);
        if (!ok) return res.status(503).json({ error: 'A backup snapshot is being taken. Please retry in a few seconds.' });
        if (this.maintenanceMsg) return res.status(503).json({ error: this.maintenanceMsg, maintenance: true });
      }
      const counted = !allowed && !NOT_COUNTED.test(url);
      if (counted) this.inflight++;
      if (isWrite) this.inflightWrites++;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (counted) this.inflight--;
        if (isWrite) this.inflightWrites--;
        this.notify();
      };
      res.on('finish', finish);
      res.on('close', finish);
      next();
    };
  }
}
