// Notification pipeline: pick recipients → record in-app notification (deduplicated) → push.
//
// Rules
//  * Recipients must be active, still have access to the project (admin, or project member)
//    and hold the capability the event requires (e.g. payments.read for payment alerts).
//  * A user's event-type choices and per-project mutes apply to both the in-app list and push;
//    the push on/off switch only controls push delivery.
//  * UNIQUE (user_id, dedupe_key) makes every event idempotent: retries, repeated edits with the
//    same value and repeated scheduler runs never create a second alert.
//  * Push payloads carry only generic text and an in-app link; details require login.
//  * Per-user push rate limit; excess alerts stay in the in-app list.
import type pg from 'pg';
import type { Role } from '../../shared/constants';
import type { NotificationEventType } from '../../shared/constants';
import { can, type Capability } from '../permissions';
import { topicFor, type PushSender } from './push';

export type Section = 'payments' | 'materials' | 'consultant' | 'site' | 'timeline';

export interface NotifyEvent {
  projectId: string;
  eventType: NotificationEventType;
  kind: string;               // e.g. 'site_visit.assigned'
  entityType: string;
  entityId: string;
  dedupeKey: string;          // unique per logical event (per user is added automatically)
  body: string;               // generic text only
  section: Section;
  recipients: string[];       // candidate user ids (filtered below)
  requiredCap: Capability | Capability[]; // recipient must hold (any of) these capabilities
  excludeUserId?: string;     // usually the user who made the change
}

export const PUSH_RATE_LIMIT = { max: 10, windowMinutes: 10 };

export class Notifier {
  private pending = new Set<Promise<unknown>>();

  constructor(private pool: pg.Pool, private sender: PushSender, private log: (m: string) => void = (m) => console.warn(m)) {}

  get pushConfigured() {
    return this.sender.configured;
  }
  get publicKey() {
    return this.sender.publicKey;
  }

  /** Fire-and-forget after the originating transaction has committed. Never throws. */
  emit(events: NotifyEvent[]): void {
    if (!events.length) return;
    const p = this.process(events).catch((e) => this.log(`[notify] failed: ${(e as Error).message}`));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Waits for in-flight notifications (used by tests and graceful shutdown). */
  async flush() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async process(events: NotifyEvent[]): Promise<number> {
    let created = 0;
    for (const ev of events) created += await this.processOne(ev);
    return created;
  }

  /** Users (with preferences) who may receive this event. */
  async eligibleRecipients(ev: NotifyEvent): Promise<Array<{ id: string; pushEnabled: boolean }>> {
    const ids = [...new Set(ev.recipients)].filter((id) => id && id !== ev.excludeUserId);
    if (!ids.length) return [];
    const { rows } = await this.pool.query(
      `SELECT u.id, u.role, COALESCE(p.push_enabled, false) AS push_enabled,
              COALESCE(p.event_types, ARRAY['site_visit','consultant_visit','task_assigned','task_due','material_date','material_due','payment_due']) AS event_types
         FROM users u
         LEFT JOIN notification_preferences p ON p.user_id = u.id
         JOIN projects pr ON pr.id = $2 AND pr.archived_at IS NULL
        WHERE u.id = ANY($1::uuid[]) AND u.is_active
          AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_id = $2))
          AND NOT EXISTS (SELECT 1 FROM notification_project_mutes x WHERE x.user_id = u.id AND x.project_id = $2)`,
      [ids, ev.projectId],
    );
    return rows
      .filter((r) => (Array.isArray(ev.requiredCap) ? ev.requiredCap : [ev.requiredCap]).some((c) => can(r.role as Role, c))
        && (r.event_types as string[]).includes(ev.eventType))
      .map((r) => ({ id: r.id as string, pushEnabled: r.push_enabled as boolean }));
  }

  private async processOne(ev: NotifyEvent): Promise<number> {
    const recipients = await this.eligibleRecipients(ev);
    if (!recipients.length) return 0;
    const { rows: pr } = await this.pool.query('SELECT code FROM projects WHERE id = $1', [ev.projectId]);
    if (!pr[0]) return 0;
    const title = `Qonnect · ${pr[0].code}`;
    const url = `/#/${ev.section}/${ev.projectId}/${ev.entityId}`;
    let created = 0;
    for (const r of recipients) {
      const ins = await this.pool.query(
        `INSERT INTO notifications (user_id, project_id, event_type, kind, entity_type, entity_id, dedupe_key, title, body, url, push_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING
         RETURNING id`,
        [r.id, ev.projectId, ev.eventType, ev.kind, ev.entityType, ev.entityId, ev.dedupeKey, title, ev.body, url,
          !r.pushEnabled ? 'skipped' : this.sender.configured ? 'pending' : 'not_configured'],
      );
      if (!ins.rows[0]) continue; // already notified for this exact event → no duplicate alert
      created++;
      if (r.pushEnabled && this.sender.configured) {
        await this.deliver(ins.rows[0].id, r.id, { title, body: ev.body, url, tag: topicFor(`${r.id}:${ev.dedupeKey}`) }, `${r.id}:${ev.dedupeKey}`);
      }
    }
    return created;
  }

  /** Sends one notification to all of the user's subscriptions, cleaning up dead ones. */
  async deliver(notificationId: string | null, userId: string, msg: { title: string; body: string; url: string; tag: string }, topicKey: string): Promise<'sent' | 'partial' | 'failed' | 'rate_limited' | 'skipped'> {
    const recent = await this.pool.query(
      `SELECT count(*)::int AS n FROM notifications
        WHERE user_id = $1 AND push_status IN ('sent','partial') AND created_at > now() - ($2 || ' minutes')::interval`,
      [userId, String(PUSH_RATE_LIMIT.windowMinutes)],
    );
    let status: 'sent' | 'partial' | 'failed' | 'rate_limited' | 'skipped';
    if (notificationId && recent.rows[0].n >= PUSH_RATE_LIMIT.max) {
      status = 'rate_limited';
    } else {
      const { rows: subs } = await this.pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
      if (!subs.length) {
        status = 'skipped';
      } else {
        let ok = 0;
        for (const s of subs) {
          const res = await this.sender.send(s, msg, topicFor(topicKey));
          if (res.ok) {
            ok++;
            await this.pool.query('UPDATE push_subscriptions SET failure_count = 0, last_success_at = now() WHERE id = $1', [s.id]);
          } else if (res.gone) {
            await this.pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
            this.log(`[notify] removed expired push subscription ${s.id} (HTTP ${res.statusCode})`);
          } else {
            // repeated failures (5+) → treat as dead
            await this.pool.query('UPDATE push_subscriptions SET failure_count = failure_count + 1, last_failure_at = now() WHERE id = $1', [s.id]);
            await this.pool.query('DELETE FROM push_subscriptions WHERE id = $1 AND failure_count >= 5', [s.id]);
            this.log(`[notify] push delivery failed for subscription ${s.id}${res.statusCode ? ` (HTTP ${res.statusCode})` : ''}`);
          }
        }
        status = ok === subs.length ? 'sent' : ok > 0 ? 'partial' : 'failed';
      }
    }
    if (notificationId) await this.pool.query('UPDATE notifications SET push_status = $2 WHERE id = $1', [notificationId, status]);
    return status;
  }
}
