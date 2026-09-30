import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config';
import { createPool } from './db';
import { createApp } from './app';
import { runMigrations } from './lib/migrate';
import { startScheduler } from './notify/scheduler';
import type { Notifier } from './notify/notifier';

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
  const stopScheduler = cfg.notifySchedulerEnabled ? startScheduler(pool, notifier, cfg.timeZone) : () => undefined;
  const server = app.listen(cfg.port, () => console.log(
    `Smart House API listening on :${cfg.port} (${cfg.nodeEnv}); web push ${notifier.pushConfigured ? 'enabled' : 'not configured'}; due-date checks ${cfg.notifySchedulerEnabled ? 'on' : 'off'}`,
  ));
  const shutdown = () => {
    stopScheduler();
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
