import type { DbClient } from '../db';
import { notFound } from './http';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`Invalid identifier ${s}`);
  return s;
};

/** Fetches one row that belongs to the given project; 404 otherwise (enforces isolation). */
export async function getOwned<T = Record<string, unknown>>(
  db: DbClient, table: string, projectId: string, id: string, opts: { forUpdate?: boolean } = {},
): Promise<T> {
  const { rows } = await db.query(
    `SELECT * FROM ${ident(table)} WHERE id = $1 AND project_id = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [id, projectId],
  );
  if (!rows[0]) throw notFound();
  return rows[0] as T;
}

/** Applies a validated patch (keys come from a zod schema) to a project-owned row. */
export async function patchOwned(
  db: DbClient, table: string, projectId: string, id: string, patch: Record<string, unknown>,
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> }> {
  const before = await getOwned(db, table, projectId, id, { forUpdate: true });
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return { before, after: before };
  const sets = keys.map((k, i) => `${ident(k)} = $${i + 3}`);
  const { rows } = await db.query(
    `UPDATE ${ident(table)} SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND project_id = $2 RETURNING *`,
    [id, projectId, ...keys.map((k) => patch[k])],
  );
  return { before, after: rows[0] };
}

export async function insertRow(db: DbClient, table: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const { rows } = await db.query(
    `INSERT INTO ${ident(table)} (${keys.map(ident).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => data[k]),
  );
  return rows[0];
}

/** Ensures an optional foreign reference points to a row in the same project. */
export async function assertSameProject(db: DbClient, table: string, projectId: string, id: string | null | undefined, label: string) {
  if (!id) return;
  const { rowCount } = await db.query(`SELECT 1 FROM ${ident(table)} WHERE id = $1 AND project_id = $2`, [id, projectId]);
  if (!rowCount) throw Object.assign(notFound(`${label} not found in this project`), { status: 400 });
}

export async function assertProjectMember(db: DbClient, projectId: string, userId: string | null | undefined, roles?: string[]) {
  if (!userId) return;
  const { rows } = await db.query(
    `SELECT u.role FROM users u LEFT JOIN project_members m ON m.user_id = u.id AND m.project_id = $1
      WHERE u.id = $2 AND u.is_active AND (m.user_id IS NOT NULL OR u.role = 'admin')`,
    [projectId, userId],
  );
  if (!rows[0] || (roles && !roles.includes(rows[0].role))) {
    throw Object.assign(notFound('Assigned user is not an active member of this project with the required role'), { status: 400 });
  }
}
