// Backup archive format (version 1) — shared by the web interface and the CLI.
//
// One uncompressed POSIX tar file, entries in this order:
//   README.txt                              what the archive is (plain text)
//   database/schema.json                    tables + columns, sequences, applied migrations
//   database/tables/<table>.ndjson.gz       every row of one table: one JSON object per line
//                                           (PostgreSQL row_to_json, read from one snapshot)
//   files/<project-id|_directory>/<name>    every uploaded file referenced by an attachment row
//   manifest.json                           written last: versions, counts, totals, checksums
//
// The archive is NOT encrypted. It contains project, financial and user data (including
// password hashes) and must be stored and transferred as confidential.
import type { MigrationFile } from '../lib/migrate';

export const BACKUP_FORMAT = 'qonnect-smarthouse-backup';
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Tables never copied into a backup. Restored installations start with these empty, so
 * every user signs in again and every device re-enables push notifications.
 * (There is no password-reset token table in this application.)
 */
export const EXCLUDED_TABLES = ['sessions', 'push_subscriptions'] as const;
/** Rebuilt from the application's own migration files on restore (listed in schema.json). */
export const MIGRATIONS_TABLE = 'schema_migrations';

export const TABLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
export const FILE_DIR_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|_directory)$/;
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface ColumnInfo { name: string; type: string; generated: boolean; identity: '' | 'a' | 'd' }
export interface TableSchema { name: string; columns: ColumnInfo[] }
export interface SchemaFile {
  formatVersion: number;
  tables: TableSchema[];
  sequences: Array<{ name: string; last_value: string | null; is_called: boolean }>;
  migrations: Array<{ filename: string; checksum: string; applied_at: string | null }>;
}

export interface AppInfo { name: string; version: string; commit: string; migrations: MigrationFile[] }

export interface ManifestTable { name: string; path: string; rows: number; uncompressedBytes: number }
export interface Manifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  backupId: string;
  createdAt: string;
  createdBy: { id: string | null; email: string | null; name: string | null } | null;
  source: 'web' | 'cli' | 'pre_restore';
  app: { name: string; version: string; commit: string };
  schema: { latest: string | null; migrations: string[] };
  postgres: { serverVersion: string };
  database: { tables: ManifestTable[]; excludedTables: string[]; sequences: number };
  /** SUM() of every numeric column as exact text (null when the table is empty) */
  totals: Record<string, Record<string, string | null>>;
  summary: {
    counts: Record<string, number>;
    projects: Array<{ id: string; code: string; name: string; archived: boolean }>;
    users: number;
  };
  attachments: {
    rows: number;
    filesIncluded: number;
    bytes: number;
    missing: Array<{ id: string; path: string }>;
    mismatched: Array<{ id: string; path: string }>;
  };
  complete: boolean;
  warnings: string[];
  encryption: 'none';
  entries: Array<{ path: string; size: number; sha256: string }>;
}

export const tableEntryPath = (t: string) => `database/tables/${t}.ndjson.gz`;

/** Relative storage path of an attachment row (same rule as the upload routes). */
export function attachmentRelPath(row: { project_id: string | null; stored_name: string }): string | null {
  const dir = row.project_id ?? '_directory';
  const name = String(row.stored_name ?? '').split('/').pop() ?? '';
  if (!FILE_DIR_RE.test(dir) || !FILE_NAME_RE.test(name)) return null;
  return `${dir}/${name}`;
}

/** Quotes an SQL identifier. Names come from the catalog or are validated with TABLE_NAME_RE. */
export const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

export const README = `Qonnect Smart House — full backup archive (format ${BACKUP_FORMAT_VERSION})

This archive contains the complete application database (one snapshot) and every uploaded
file referenced by it. It is NOT encrypted: it holds project, financial and user records,
including password hashes. Store and transfer it as confidential.

Not included: sign-in sessions, device push registrations, .env files, database passwords,
VAPID keys or any other server secret. Configure those on the new server.

Restore it only with the application's Backup & Restore page or its CLI:
  docker compose run --rm app node dist-server/backup.js validate <archive>
  docker compose run --rm app node dist-server/backup.js restore <archive> --yes
Do not extract and import it manually. See docs/BACKUP_RESTORE.md in the repository.
`;

export const fmtBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
