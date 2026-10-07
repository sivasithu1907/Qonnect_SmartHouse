// Minimal forward-only SQL migration runner. Each file in /migrations runs once,
// inside a transaction, and is recorded in schema_migrations with its checksum.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type pg from 'pg';

export interface MigrationFile { filename: string; sql: string; checksum: string }

/** The migration files shipped with this version of the application, in order. */
export function readMigrations(dir: string): MigrationFile[] {
  return fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort().map((filename) => {
    const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
    return { filename, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

export async function runMigrations(pool: pg.Pool, dir: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // serialise concurrent runners (e.g. two containers starting at once)
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]),
    );
    const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`Migration ${f} was modified after it was applied. Create a new migration instead.`);
        continue;
      }
      log(`Applying migration ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [f, sum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
    }
    if (!applied.length) log('Database schema is up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
}
