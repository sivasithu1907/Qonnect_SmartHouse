// Creates (or resets the password of) an admin user from environment variables:
//   ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD
// Nothing is hard-coded; unset the variables after use.
import { createPool, resolveDatabaseUrl } from '../db';
import { hashPassword, passwordProblems } from '../lib/passwords';

async function main() {
  const url = resolveDatabaseUrl();
  const email = process.env.ADMIN_EMAIL?.trim();
  const name = process.env.ADMIN_NAME?.trim() || 'Administrator';
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('ADMIN_EMAIL is required');
  const problem = passwordProblems(password);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  const pool = createPool(url);
  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,'admin',$3)
       ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = true,
         failed_logins = 0, locked_until = NULL, updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [email, name, hash],
    );
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
    await pool.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, summary) VALUES ($1, 'user', $2, $3)`,
      [rows[0].inserted ? 'create' : 'update', rows[0].id, `Admin ${email} ${rows[0].inserted ? 'created' : 'password reset'} via CLI`],
    );
    console.log(`Admin ${email} ${rows[0].inserted ? 'created' : 'updated'}.`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
