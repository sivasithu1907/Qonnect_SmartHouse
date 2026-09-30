-- 003_notifications_push.sql
--
-- Additive and safe for existing data: only new tables and one new nullable column.
-- Nothing is changed, deleted or re-seeded in existing tables.
--
--   * push_subscriptions        — Web Push subscriptions, each owned by exactly one user (one row per browser/device)
--   * notification_preferences  — per-user push on/off and enabled event types
--   * notification_project_mutes— per-user, per-project opt-out
--   * notifications             — per-user in-app notification list; UNIQUE (user_id, dedupe_key) guarantees an
--                                 event is recorded and pushed at most once per user, even on retries
--   * timeline_tasks.assigned_user_id — optional assignee (existing free-text "responsible" is kept unchanged)

CREATE TABLE push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  expiration_time timestamptz,
  user_agent      text NOT NULL DEFAULT '',
  failure_count   integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- a browser subscription (endpoint) belongs to one user at a time
CREATE UNIQUE INDEX push_subscriptions_endpoint_uq ON push_subscriptions (endpoint);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

CREATE TABLE notification_preferences (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL DEFAULT false,
  event_types  text[] NOT NULL DEFAULT ARRAY[
    'site_visit', 'consultant_visit', 'task_assigned', 'task_due', 'material_date', 'material_due', 'payment_due'
  ]::text[],
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_project_mutes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id),
  event_type   text NOT NULL,
  kind         text NOT NULL,          -- e.g. site_visit.assigned, payment.overdue
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  dedupe_key   text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,          -- generic, never amounts / bank details / personal data
  url          text NOT NULL,          -- in-app route, e.g. /#/payments/<project>/<record>
  push_status  text NOT NULL DEFAULT 'pending'
                 CHECK (push_status IN ('pending','sent','partial','failed','skipped','rate_limited','not_configured')),
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (user_id, dedupe_key);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE timeline_tasks ADD COLUMN assigned_user_id uuid REFERENCES users(id);
