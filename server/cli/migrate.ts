import path from 'node:path';
import { createPool, resolveDatabaseUrl } from '../db';
import { runMigrations } from '../lib/migrate';

const url = resolveDatabaseUrl();
const pool = createPool(url);
runMigrations(pool, path.resolve(process.env.MIGRATIONS_DIR ?? './migrations'))
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e.message ?? e);
    await pool.end();
    process.exit(1);
  });
