// Catalog introspection used by backup and restore. Every table of the schema is discovered
// from PostgreSQL itself, so tables added by future migrations are included automatically.
import type pg from 'pg';
import { qi, type ColumnInfo, type TableSchema } from './format';

type Q = pg.PoolClient | pg.Client;

export async function schemaExists(c: Q, schema: string): Promise<boolean> {
  return (await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount === 1;
}

export async function listTables(c: Q, schema: string): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname`, [schema]);
  return rows.map((r) => r.relname as string);
}

export async function tableColumns(c: Q, schema: string, table: string): Promise<ColumnInfo[]> {
  const { rows } = await c.query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attgenerated <> '' AS generated, a.attidentity::text AS identity
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table]);
  return rows.map((r) => ({ name: r.attname, type: r.type, generated: r.generated, identity: (r.identity || '') as ColumnInfo['identity'] }));
}

export async function describeSchema(c: Q, schema: string, exclude: readonly string[]): Promise<TableSchema[]> {
  const out: TableSchema[] = [];
  for (const t of await listTables(c, schema)) {
    if (exclude.includes(t)) continue;
    out.push({ name: t, columns: await tableColumns(c, schema, t) });
  }
  return out;
}

export async function listSequences(c: Q, schema: string) {
  const { rows } = await c.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY c.relname`, [schema]);
  const out: Array<{ name: string; last_value: string | null; is_called: boolean }> = [];
  for (const r of rows) {
    const v = await c.query(`SELECT last_value::text AS last_value, is_called FROM ${qi(schema)}.${qi(r.relname)}`);
    out.push({ name: r.relname, last_value: v.rows[0].last_value, is_called: v.rows[0].is_called });
  }
  return out;
}

export async function foreignKeys(c: Q, schema: string) {
  const { rows } = await c.query(
    `SELECT cl.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = $1 AND con.contype = 'f' ORDER BY cl.relname, con.conname`, [schema]);
  return rows as Array<{ table: string; name: string; def: string }>;
}

export const isNumericType = (type: string) => /^numeric\b/.test(type);

/** SUM() of every numeric column, as exact text. */
export async function numericTotals(c: Q, schema: string, table: string, columns: ColumnInfo[]): Promise<Record<string, string | null> | null> {
  const nums = columns.filter((col) => isNumericType(col.type));
  if (!nums.length) return null;
  const { rows } = await c.query(`SELECT ${nums.map((n) => `sum(${qi(n.name)})::text AS ${qi(n.name)}`).join(', ')} FROM ${qi(schema)}.${qi(table)}`);
  return rows[0];
}

export async function rowCount(c: Q, schema: string, table: string): Promise<number> {
  const { rows } = await c.query(`SELECT count(*)::bigint::text AS n FROM ${qi(schema)}.${qi(table)}`);
  return Number(rows[0].n);
}

/** Session settings that make row_to_json output exact and independent of the server locale. */
export const SNAPSHOT_SETTINGS = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  'SET LOCAL extra_float_digits = 3',
  "SET LOCAL bytea_output = 'hex'",
];
