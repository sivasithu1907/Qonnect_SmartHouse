import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config';
import { createPool } from './db';
import { createApp } from './app';
import { runMigrations } from './lib/migrate';
import { startScheduler } from './notify/scheduler';
import type { Notifier } from './notify/notifier';
import pg from 'pg';
import type { OpsState } from './backup/ops';
import { APP_RUNNING_LOCK, type BackupService } from './backup/service';

/** Holds a shared advisory lock while the web app runs, so the restore CLI refuses to run alongside it. */
function holdAppRunningLock(url: string) {
  let client: pg.Client | null = null;
  const connect = async () => {
    try {
      client = new pg.Client({ connectionString: url });
      client.on('error', () => { client = null; setTimeout(() => void connect(), 5000).unref(); });
      await client.connect();
      await client.query('SELECT pg_advisory_lock_shared($1)', [APP_RUNNING_LOCK]);
    } catch {
      client = null;
      setTimeout(() => void connect(), 5000).unref();
    }
  };
  void connect();
  return () => (client as pg.Client | null)?.end().catch(() => undefined);
}

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  if (process.env.MIGRATE_ON_START === 'true') {
    await runMigrations(pool, path.resolve(process.env.MIGRATIONS_DIR ?? './migrations'));
  }
  fs.mkdirSync(cfg.uploadDir, { recursive: true, mode: 0o750 });
  // purge expired sessions hourly
  setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => undefined), 3600_000).unref();
  const app = createApp(pool, cfg);
  const notifier = app.locals.notifier as Notifier;
  const ops = app.locals.ops as OpsState;
  // finish or undo an interrupted backup / restore before serving requests
  await (app.locals.backup as BackupService).recoverOnStartup().catch((e) => console.warn(`[backup] startup recovery: ${(e as Error).message}`));
  const releaseRunningLock = holdAppRunningLock(cfg.databaseUrl);
  const stopScheduler = cfg.notifySchedulerEnabled ? startScheduler(pool, notifier, cfg.timeZone, undefined, () => ops.jobsPaused) : () => undefined;
  const server = app.listen(cfg.port, () => console.log(
    `Smart House API listening on :${cfg.port} (${cfg.nodeEnv}); web push ${notifier.pushConfigured ? 'enabled' : 'not configured'}; due-date checks ${cfg.notifySchedulerEnabled ? 'on' : 'off'}${ops.persisted.jobsPaused ? ' (background jobs PAUSED: ' + ops.persisted.pausedReason + ')' : ''}`,
  ));
  const shutdown = () => {
    stopScheduler();
    void releaseRunningLock();
    server.close(() => notifier.flush().finally(() => pool.end().finally(() => process.exit(0))));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
