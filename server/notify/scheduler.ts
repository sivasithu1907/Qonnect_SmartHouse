// Periodic due-date checks (payments, materials, timeline tasks). Uses only dates already
// stored on records; items without a date never alert. Each alert's dedupe key includes the
// due date, so it is sent once per date (not every run) and again only if the date changes.
import type pg from 'pg';
import { addDaysISO, todayISO } from '../../shared/calc';
import type { NotifyEvent, Notifier } from './notifier';
import { projectUserIds } from './events';

export const DUE_SOON_DAYS = 3;
const LOCK_KEY = 727002;

export async function collectDueEvents(db: pg.Pool | pg.PoolClient, today: string): Promise<NotifyEvent[]> {
  const soon = addDaysISO(today, DUE_SOON_DAYS);
  const events: NotifyEvent[] = [];
  const usersCache = new Map<string, string[]>();
  const usersOf = async (pid: string) => {
    if (!usersCache.has(pid)) usersCache.set(pid, await projectUserIds(db, pid));
    return usersCache.get(pid)!;
  };

  // --- payment milestones with an unpaid balance (active, not archived, active project)
  const pay = await db.query(
    `SELECT m.id, m.project_id, m.due_date::text AS due
       FROM payment_milestones m JOIN projects p ON p.id = m.project_id AND p.archived_at IS NULL
      WHERE m.archived_at IS NULL AND m.status = 'active' AND m.due_date IS NOT NULL AND m.due_date <= $1
        AND m.scheduled_amount > COALESCE((SELECT SUM(t.amount) FROM payment_transactions t WHERE t.milestone_id = m.id AND t.archived_at IS NULL), 0)`,
    [soon],
  );
  for (const r of pay.rows) {
    const overdue = r.due < today;
    events.push({
      projectId: r.project_id, eventType: 'payment_due', kind: overdue ? 'payment.overdue' : 'payment.due_soon',
      entityType: 'payment_milestone', entityId: r.id, section: 'payments',
      dedupeKey: `${overdue ? 'payment.overdue' : 'payment.due_soon'}:${r.id}:${r.due}`,
      body: overdue ? 'A payment milestone needs attention.' : 'A payment milestone is due soon.',
      recipients: await usersOf(r.project_id), requiredCap: 'payments.read',
    });
  }

  // --- open material lines by their governing delivery date
  const mats = await db.query(
    `SELECT m.id, m.project_id, m.assigned_contractor_id,
            COALESCE(m.revised_delivery_date, m.confirmed_delivery_date, m.planned_delivery_date, m.required_on_site_date)::text AS due
       FROM material_items m JOIN projects p ON p.id = m.project_id AND p.archived_at IS NULL
      WHERE m.archived_at IS NULL AND m.actual_delivery_date IS NULL
        AND m.status NOT IN ('Delivered','Accepted','Cancelled')
        AND COALESCE(m.revised_delivery_date, m.confirmed_delivery_date, m.planned_delivery_date, m.required_on_site_date) <= $1`,
    [soon],
  );
  for (const r of mats.rows) {
    const overdue = r.due < today;
    const kind = overdue ? 'material.overdue' : 'material.due_soon';
    const common = {
      projectId: r.project_id, eventType: 'material_due' as const, kind, entityType: 'material', entityId: r.id, section: 'materials' as const,
      dedupeKey: `${kind}:${r.id}:${r.due}`, body: overdue ? 'A material delivery is overdue.' : 'A material delivery is due soon.',
    };
    events.push({ ...common, recipients: await usersOf(r.project_id), requiredCap: 'materials.write' });
    if (r.assigned_contractor_id) events.push({ ...common, recipients: [r.assigned_contractor_id], requiredCap: 'materials.contractor' });
  }

  // --- timeline tasks with a planned finish date that are not completed
  const tasks = await db.query(
    `SELECT t.id, t.project_id, t.assigned_user_id, t.planned_end::text AS due
       FROM timeline_tasks t JOIN projects p ON p.id = t.project_id AND p.archived_at IS NULL
       JOIN timeline_phases ph ON ph.id = t.phase_id AND ph.archived_at IS NULL
      WHERE t.archived_at IS NULL AND t.status <> 'Completed' AND t.planned_end IS NOT NULL AND t.planned_end <= $1`,
    [soon],
  );
  for (const r of tasks.rows) {
    const overdue = r.due < today;
    const kind = overdue ? 'task.overdue' : 'task.due_soon';
    const common = {
      projectId: r.project_id, eventType: 'task_due' as const, kind, entityType: 'timeline_task', entityId: r.id, section: 'timeline' as const,
      dedupeKey: `${kind}:${r.id}:${r.due}`, body: overdue ? 'A timeline task is overdue.' : 'A timeline task is due soon.',
    };
    if (r.assigned_user_id) {
      events.push({ ...common, recipients: [r.assigned_user_id], requiredCap: 'timeline.read' });
      if (overdue) events.push({ ...common, recipients: await usersOf(r.project_id), requiredCap: 'timeline.write' }); // managers hear about overdue work
    } else {
      events.push({ ...common, recipients: await usersOf(r.project_id), requiredCap: 'timeline.write' }); // unassigned → project managers
    }
  }
  return events;
}

/** One scheduler pass, guarded by an advisory lock so parallel instances cannot double-send. */
export async function runDueChecks(pool: pg.Pool, notifier: Notifier, timeZone: string, today = todayISO(timeZone)): Promise<number> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!rows[0].ok) return 0;
    try {
      const events = await collectDueEvents(client, today);
      return await notifier.process(events);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export function startScheduler(pool: pg.Pool, notifier: Notifier, timeZone: string, everyMs = 60 * 60_000) {
  const run = () => runDueChecks(pool, notifier, timeZone).catch((e) => console.warn(`[notify] due-date check failed: ${(e as Error).message}`));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, everyMs);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
