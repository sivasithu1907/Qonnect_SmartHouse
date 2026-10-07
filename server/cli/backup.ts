// Backup & restore from the command line — the disaster-recovery path that works when the web
// application cannot start. Same archive format and checks as Settings → Backup & Restore.
//
// Inside the Docker stack (paths are inside the app container):
//   docker compose run --rm app node dist-server/backup.js create
//   docker compose run --rm app node dist-server/backup.js list
//   docker compose run --rm -v /root/restore:/restore:ro app node dist-server/backup.js validate /restore/<archive>.tar
//   docker compose stop app
//   docker compose run --rm -v /root/restore:/restore:ro app node dist-server/backup.js restore /restore/<archive>.tar --yes [--replace-existing]
//   docker compose run --rm app node dist-server/backup.js resume-jobs
//   docker compose run --rm app node dist-server/backup.js previous-db status|rollback --yes|discard --yes
import fs from 'node:fs';
import path from 'node:path';
import { createPool, resolveDatabaseUrl } from '../db';
import { loadConfig } from '../config';
import { readMigrations } from '../lib/migrate';
import { OpsState } from '../backup/ops';
import { BackupService, readAppInfo } from '../backup/service';
import { fmtBytes } from '../backup/format';
import { COUNT_LABELS } from '../backup/create';

const HELP = `Qonnect Smart House — backup & restore CLI

  create                         Create a verified full backup in BACKUP_DIR (${process.env.BACKUP_DIR ?? './data/backups'})
  list                           List backups stored in BACKUP_DIR
  validate <archive.tar>         Check an archive without changing anything
  restore <archive.tar> --yes    Restore an archive (the web app must be stopped).
        --replace-existing       required when this installation already has projects or users
        --skip-safety-backup     do not back up the current data first (not recommended)
  resume-jobs                    Resume background jobs and notifications after recovery checks
  previous-db status             Show whether the data from before the last restore is kept
  previous-db rollback --yes     Switch back to the data from before the last restore
  previous-db discard --yes      Drop the data kept from before the last restore
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  if (!cmd || cmd === 'help' || flags.has('--help')) { console.log(HELP); return; }

  const cfg = loadConfig({ databaseUrl: resolveDatabaseUrl() });
  const pool = createPool(cfg.databaseUrl);
  const ops = new OpsState(path.join(cfg.backupDir, 'ops-state.json'));
  const svc = new BackupService(pool, {
    uploadDir: cfg.uploadDir, backupDir: cfg.backupDir, backupRetention: cfg.backupRetention, backupMaxUploadBytes: cfg.backupMaxUploadMb * 1024 * 1024,
  }, ops, readAppInfo(cfg.migrationsDir, readMigrations), (m) => console.log(m));
  let lastLine = '';
  svc.onProgress = (p, d, t) => {
    const line = d && t ? `${p} (${d}/${t})` : p;
    if (line !== lastLine && (!d || !t || d === t || d % 25 === 1)) console.log(`  … ${line}`);
    lastLine = line;
  };
  const actor = { id: null, email: `cli@${process.env.HOSTNAME ?? 'server'}`, name: 'Command line' };
  try {
    switch (cmd) {
      case 'create': {
        const m = await svc.backupNow(actor, 'cli');
        console.log(`\n${m.status === 'verified' ? 'Backup created and verified' : 'Backup created but INCOMPLETE'}: ${svc.store.archivePath(m.id)}`);
        console.log(`  size ${fmtBytes(m.size ?? 0)}, schema ${m.schemaVersion}, ${m.attachments?.filesIncluded ?? 0} files`);
        console.log(`  download name: ${m.fileName}`);
        for (const w of m.warnings) console.log(`  WARNING: ${w}`);
        console.log('  The archive is NOT encrypted. Copy it off the server to a protected location.');
        if (m.status !== 'verified') process.exitCode = 2;
        break;
      }
      case 'list': {
        const all = svc.store.list();
        if (!all.length) console.log('No backups in', cfg.backupDir);
        for (const m of all) console.log(`${m.createdAt}  ${m.status.padEnd(10)} ${m.kind.padEnd(11)} ${fmtBytes(m.size ?? 0).padStart(9)}  ${m.schemaVersion ?? '-'}  ${svc.store.archivePath(m.id)}`);
        break;
      }
      case 'validate': {
        const file = args[0];
        if (!file || !fs.existsSync(file)) throw new Error('Usage: validate <archive.tar> (the path must be inside the container, e.g. a mounted /restore folder)');
        const r = await svc.validateFile(path.resolve(file));
        printReport(r);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'restore': {
        const file = args[0];
        if (!file || !fs.existsSync(file)) throw new Error('Usage: restore <archive.tar> --yes');
        if (!flags.has('--yes')) throw new Error('Refusing to restore without --yes. This replaces the whole database of this installation.');
        console.log('Validating and restoring. The current data is kept until the restored copy has passed every check.');
        const res = await svc.restoreNow(path.resolve(file), actor, { preBackup: !flags.has('--skip-safety-backup'), replaceExisting: flags.has('--replace-existing') });
        console.log(`\nRestore completed from the backup of ${res.backupCreatedAt}.`);
        console.log(`  ${res.tables} tables, ${res.rows} rows, ${res.files.written} files written, ${res.files.reused} already present`);
        if (res.pendingMigrationsApplied.length) console.log(`  newer database changes applied: ${res.pendingMigrationsApplied.join(', ')}`);
        if (res.preRestoreBackupId) console.log(`  safety backup of the previous data: ${svc.store.archivePath(res.preRestoreBackupId)}`);
        if (res.previousSchema) console.log(`  previous data also kept in the database as ${res.previousSchema} (previous-db rollback / discard)`);
        for (const w of res.warnings) console.log(`  WARNING: ${w}`);
        console.log('\nNext: start the app (docker compose up -d app), sign in with an account from the backup, complete the');
        console.log('recovery checks, then resume background jobs in Settings → Backup & Restore (or: backup.js resume-jobs).');
        break;
      }
      case 'resume-jobs': {
        await svc.resumeJobs(actor);
        console.log('Background jobs and notifications resumed. Restart the app if it is running: docker compose restart app');
        break;
      }
      case 'previous-db': {
        const action = (args[0] ?? 'status') as 'status' | 'rollback' | 'discard';
        if (!['status', 'rollback', 'discard'].includes(action)) throw new Error('previous-db status | rollback --yes | discard --yes');
        if (action !== 'status' && !flags.has('--yes')) throw new Error(`Refusing to ${action} without --yes.`);
        console.log(await svc.previousDb(action, actor));
        break;
      }
      default:
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

function printReport(r: Awaited<ReturnType<BackupService['validateFile']>>) {
  const m = r.manifest;
  console.log(r.ok ? 'VALID backup archive' : 'REJECTED');
  if (m) {
    console.log(`  created     ${m.createdAt} by ${m.createdBy?.email ?? 'unknown'} (${m.source})`);
    console.log(`  application ${m.app.version}${m.app.commit ? ` (${m.app.commit})` : ''}, database ${m.schemaLatest}, PostgreSQL ${m.postgres}`);
    console.log(`  complete    ${m.complete ? 'yes' : 'NO — some attachment files were missing'}; encryption: ${m.encryption}`);
  }
  console.log(`  compatibility: ${r.compatibility.message}`);
  for (const [k, label] of Object.entries(COUNT_LABELS)) if (r.counts[k] !== undefined) console.log(`  ${label.padEnd(36)} ${r.counts[k]}`);
  console.log(`  attachment files: ${r.attachments.filesIncluded} (${fmtBytes(r.attachments.bytes)}), missing ${r.attachments.missing}`);
  for (const e of r.errors) console.log(`  ERROR: ${e}`);
  for (const w of r.warnings.slice(0, 20)) console.log(`  WARNING: ${w}`);
}

main().catch((e) => {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
});
