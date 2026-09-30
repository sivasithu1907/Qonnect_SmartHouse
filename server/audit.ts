import type { Request } from 'express';
import type { DbClient } from './db';

export interface AuditEntry {
  projectId: string | null;
  action: string;          // create | update | archive | restore | approve | login ...
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

/** Records an audit entry. Call inside the same transaction as the change. */
export async function audit(db: DbClient, req: Request | null, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (project_id, user_id, user_email, action, entity_type, entity_id, summary, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      e.projectId,
      req?.user?.id ?? null,
      req?.user?.email ?? null,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.summary ?? '',
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      req?.ip ?? null,
    ],
  );
}

/** Returns only the keys whose values changed, for compact audit diffs. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (k === 'updated_at') continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}
