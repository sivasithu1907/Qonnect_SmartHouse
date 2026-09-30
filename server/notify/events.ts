// Builds notification events from record changes. Only meaningful changes produce events
// (assignment, rescheduling, delivery-date changes) — ordinary edits do not.
import type pg from 'pg';
import type { NotifyEvent } from './notifier';
import { effectiveDeliveryDate } from '../../shared/calc';

type Row = Record<string, any>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v));

/** Every user who can currently access the project (members + admins). Capability filtering happens in the notifier. */
export async function projectUserIds(db: pg.Pool | pg.PoolClient, projectId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT u.id FROM users u
      WHERE u.is_active AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_id = $1))`,
    [projectId],
  );
  return rows.map((r) => r.id);
}

export function siteVisitEvents(before: Row | null, after: Row, actorId: string): NotifyEvent[] {
  const uid = after.assigned_user_id as string | null;
  if (!uid || after.archived_at) return [];
  const base = { projectId: after.project_id, eventType: 'site_visit' as const, entityType: 'site_visit', entityId: after.id, section: 'site' as const, recipients: [uid], requiredCap: 'site.read' as const, excludeUserId: actorId };
  if (!before || before.assigned_user_id !== uid) {
    return [{ ...base, kind: 'site_visit.assigned', dedupeKey: `site_visit.assigned:${after.id}:${uid}`, body: 'A site visit has been assigned to you.' }];
  }
  const moved = before.visit_at && iso(before.visit_at) !== iso(after.visit_at);
  const markedRescheduled = before.status !== 'Rescheduled' && after.status === 'Rescheduled';
  if (moved || markedRescheduled) {
    return [{ ...base, kind: 'site_visit.rescheduled', dedupeKey: `site_visit.rescheduled:${after.id}:${iso(after.visit_at)}:${after.status}`, body: 'A site visit assigned to you has been rescheduled.' }];
  }
  return [];
}

export function consultantVisitEvents(before: Row | null, after: Row, actorId: string): NotifyEvent[] {
  const uid = after.consultant_user_id as string | null;
  if (!uid || after.archived_at) return [];
  const base = { projectId: after.project_id, eventType: 'consultant_visit' as const, entityType: 'consultant_visit', entityId: after.id, section: 'consultant' as const, recipients: [uid], requiredCap: 'consultant.read' as const, excludeUserId: actorId };
  if (!before || before.consultant_user_id !== uid) {
    return [{ ...base, kind: 'consultant_visit.assigned', dedupeKey: `consultant_visit.assigned:${after.id}:${uid}`, body: 'A consultant visit has been assigned to you.' }];
  }
  const moved = before.planned_at && iso(before.planned_at) !== iso(after.planned_at);
  const markedRescheduled = before.status !== 'Rescheduled' && after.status === 'Rescheduled';
  if (moved || markedRescheduled) {
    return [{ ...base, kind: 'consultant_visit.rescheduled', dedupeKey: `consultant_visit.rescheduled:${after.id}:${iso(after.planned_at)}:${after.status}`, body: 'A consultant visit assigned to you has been rescheduled.' }];
  }
  return [];
}

export function taskAssignedEvents(before: Row | null, after: Row, actorId: string): NotifyEvent[] {
  const uid = after.assigned_user_id as string | null;
  if (!uid || after.archived_at || after.status === 'Completed') return [];
  if (before && before.assigned_user_id === uid) return [];
  return [{
    projectId: after.project_id, eventType: 'task_assigned', kind: 'task.assigned', entityType: 'timeline_task', entityId: after.id,
    dedupeKey: `task.assigned:${after.id}:${uid}`, body: 'A timeline task has been assigned to you.', section: 'timeline',
    recipients: [uid], requiredCap: 'timeline.read', excludeUserId: actorId,
  }];
}

/** Delivery-date change on a material line → material managers and the assigned contractor. */
export async function materialDateEvents(db: pg.Pool | pg.PoolClient, before: Row, after: Row, actorId: string): Promise<NotifyEvent[]> {
  const b = effectiveDeliveryDate(before as never);
  const a = effectiveDeliveryDate(after as never);
  if (after.archived_at || (b.date === a.date && b.basis === a.basis)) return [];
  const common = {
    projectId: after.project_id, eventType: 'material_date' as const, kind: 'material.date_changed', entityType: 'material', entityId: after.id,
    dedupeKey: `material.date_changed:${after.id}:${a.basis}:${a.date ?? 'none'}`, body: 'A material delivery date has changed.', section: 'materials' as const,
    excludeUserId: actorId,
  };
  const events: NotifyEvent[] = [{ ...common, recipients: await projectUserIds(db, after.project_id), requiredCap: 'materials.write' }];
  if (after.assigned_contractor_id) events.push({ ...common, recipients: [after.assigned_contractor_id], requiredCap: 'materials.contractor' });
  return events;
}
