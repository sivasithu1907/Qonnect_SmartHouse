import pg from 'pg';

// numeric -> number, int8 -> number, date -> 'YYYY-MM-DD' string (no timezone shifting)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Returns the PostgreSQL connection string. Uses DATABASE_URL if set; otherwise builds it
 * from DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD, URL-encoding user and password
 * so any characters (including + / = @ : from Base64) are safe.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { DB_HOST, DB_NAME, DB_USER, DB_PASSWORD } = env;
  if (!DB_HOST || !DB_NAME || !DB_USER || DB_PASSWORD === undefined) {
    throw new Error('Database is not configured: set DATABASE_URL, or DB_HOST, DB_NAME, DB_USER and DB_PASSWORD');
  }
  const port = env.DB_PORT || '5432';
  return `postgres://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${port}/${encodeURIComponent(DB_NAME)}`;
}
