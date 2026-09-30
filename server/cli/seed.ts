// Seeds ONLY the two owner-supplied projects and their source-backed values.
// Idempotent: a project whose code already exists is left untouched.
import { createPool, resolveDatabaseUrl } from '../db';
import { seedProjects } from '../seed/apply';

const url = resolveDatabaseUrl();
const pool = createPool(url);
seedProjects(pool)
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e.message ?? e);
    await pool.end();
    process.exit(1);
  });
