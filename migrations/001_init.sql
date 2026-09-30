-- 001_init.sql — core schema for Qonnect Smart House project control
-- All project-owned tables carry project_id and are filtered server-side.
-- Important records are archived (archived_at), never hard-deleted by the app.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users & auth
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','project_manager','contractor','consultant','viewer')),
  password_hash   text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id          text PRIMARY KEY,                -- sha256(token); raw token only lives in the cookie
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          text,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      text NOT NULL,
  name                      text NOT NULL,
  location                  text NOT NULL DEFAULT '',
  description               text NOT NULL DEFAULT '',
  client                    text NOT NULL DEFAULT '',
  status                    text NOT NULL DEFAULT 'Setup',
  planned_start_date        date,
  target_completion_date    date,
  misc_percentage           numeric(5,2) NOT NULL DEFAULT 10.00 CHECK (misc_percentage >= 0 AND misc_percentage <= 100),
  misc_basis                text NOT NULL DEFAULT 'approved_finishing'
                              CHECK (misc_basis IN ('approved_finishing','variant_a_finishing','variant_b_finishing')),
  control_budget            numeric(14,2) CHECK (control_budget IS NULL OR control_budget >= 0),
  control_budget_confirmed  boolean NOT NULL DEFAULT false,
  control_budget_confirmed_by uuid REFERENCES users(id),
  control_budget_confirmed_at timestamptz,
  drive_folder_url          text NOT NULL DEFAULT '',
  sheets_url                text NOT NULL DEFAULT '',
  payments_drive_url        text NOT NULL DEFAULT '',
  materials_drive_url       text NOT NULL DEFAULT '',
  consultant_drive_url      text NOT NULL DEFAULT '',
  site_visits_drive_url     text NOT NULL DEFAULT '',
  notes                     text NOT NULL DEFAULT '',
  archived_at               timestamptz,
  archived_by               uuid REFERENCES users(id),
  created_by                uuid REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_code_uq ON projects (upper(regexp_replace(code, '\s+', ' ', 'g')));

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);

-- ---------------------------------------------------------------- master items & budget
CREATE TABLE budget_categories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id),
  name                  text NOT NULL,
  kind                  text NOT NULL DEFAULT 'finishing' CHECK (kind IN ('finishing','fixed','other')),
  include_in_misc_basis boolean NOT NULL DEFAULT true,
  sort_order            integer NOT NULL DEFAULT 0,
  source_label          text NOT NULL DEFAULT '',
  notes                 text NOT NULL DEFAULT '',
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_categories_project_idx ON budget_categories (project_id);

CREATE TABLE budget_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  category_id       uuid NOT NULL REFERENCES budget_categories(id),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  quantity          numeric(14,3),
  unit              text NOT NULL DEFAULT '',
  -- original source values (reference only, never commitments)
  source_amount     numeric(14,2),            -- single-value sources (e.g. fixed costs)
  source_variant_a  numeric(14,2),            -- Variant A – Individual
  source_variant_b  numeric(14,2),            -- Variant B – Al Wathab
  source_status     text NOT NULL DEFAULT '', -- e.g. 'Variant B: Not priced'
  source_label      text NOT NULL DEFAULT '',
  -- selected / approved project amount (blank until owner enters/approves)
  approved_amount   numeric(14,2) CHECK (approved_amount IS NULL OR approved_amount >= 0),
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  notes             text NOT NULL DEFAULT '',
  sort_order        integer NOT NULL DEFAULT 0,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_items_project_idx ON budget_items (project_id);
CREATE INDEX budget_items_category_idx ON budget_items (category_id);

-- Source dashboard summary figures, preserved verbatim as references ("Needs review")
CREATE TABLE source_references (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  label           text NOT NULL,
  variant_a_value numeric(14,2),
  variant_b_value numeric(14,2),
  review_status   text NOT NULL DEFAULT 'Needs review' CHECK (review_status IN ('Needs review','Reviewed','Superseded')),
  note            text NOT NULL DEFAULT '',
  source_label    text NOT NULL DEFAULT '',
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_references_project_idx ON source_references (project_id);

-- ---------------------------------------------------------------- payments
CREATE TABLE payment_milestones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id),
  payee_type       text NOT NULL CHECK (payee_type IN ('contractor','consultant','kahramaa','supplier','other')),
  payee_name       text NOT NULL,
  cost_category    text NOT NULL DEFAULT '',
  budget_item_id   uuid REFERENCES budget_items(id),
  po_contract_ref  text NOT NULL DEFAULT '',
  invoice_ref      text NOT NULL DEFAULT '',
  description      text NOT NULL,
  due_date         date,
  scheduled_amount numeric(14,2) NOT NULL CHECK (scheduled_amount > 0),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','cancelled')),
  notes            text NOT NULL DEFAULT '',
  archived_at      timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_milestones_project_idx ON payment_milestones (project_id);

CREATE TABLE payment_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  milestone_id  uuid NOT NULL REFERENCES payment_milestones(id),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_date     date NOT NULL,
  method        text NOT NULL CHECK (method IN ('bank_transfer','cheque','cash','card','other')),
  reference     text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  archived_at   timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_transactions_project_idx ON payment_transactions (project_id);
CREATE INDEX payment_transactions_milestone_idx ON payment_transactions (milestone_id);
-- Duplicate protection: the same bank/cheque reference cannot be recorded twice in a project
CREATE UNIQUE INDEX payment_transactions_ref_uq
  ON payment_transactions (project_id, method, upper(btrim(reference)))
  WHERE archived_at IS NULL AND btrim(reference) <> '';

-- ---------------------------------------------------------------- material supply
CREATE TABLE material_scope_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  category          text NOT NULL,
  owner_supply      text NOT NULL DEFAULT '',
  contractor_scope  text NOT NULL DEFAULT '',
  source_label      text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX material_scope_notes_uq ON material_scope_notes (project_id, category);

CREATE TABLE material_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES projects(id),
  category                text NOT NULL,
  description             text NOT NULL,
  quantity                numeric(14,3),
  unit                    text NOT NULL DEFAULT '',
  amount                  numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  supply_responsibility   text NOT NULL DEFAULT 'needs_confirmation'
                            CHECK (supply_responsibility IN ('owner','contractor','needs_confirmation')),
  responsibility_note     text NOT NULL DEFAULT '',
  vendor                  text NOT NULL DEFAULT '',
  assigned_contractor_id  uuid REFERENCES users(id),
  status                  text NOT NULL DEFAULT 'Status not confirmed',
  required_on_site_date   date,               -- "supply due date" in the source tracker
  planned_delivery_date   date,
  confirmed_delivery_date date,
  revised_delivery_date   date,
  actual_delivery_date    date,
  delivery_date_note      text NOT NULL DEFAULT '',
  qty_ordered             numeric(14,3),
  qty_delivered           numeric(14,3),
  inspection_status       text NOT NULL DEFAULT '' CHECK (inspection_status IN ('','Not required','Pending','Passed','Conditionally accepted','Rejected')),
  next_follow_up_date     date,
  document_url            text NOT NULL DEFAULT '',
  notes                   text NOT NULL DEFAULT '',
  source_label            text NOT NULL DEFAULT '',
  is_package              boolean NOT NULL DEFAULT false,
  sort_order              integer NOT NULL DEFAULT 0,
  archived_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX material_items_project_idx ON material_items (project_id);

-- ---------------------------------------------------------------- timeline
CREATE TABLE timeline_phases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  seq               integer NOT NULL,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  planned_start     date,
  planned_end       date,
  actual_start      date,
  actual_end        date,
  schedule_approved boolean NOT NULL DEFAULT false,
  notes             text NOT NULL DEFAULT '',
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timeline_phases_project_idx ON timeline_phases (project_id);

CREATE TABLE timeline_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  phase_id      uuid NOT NULL REFERENCES timeline_phases(id),
  template_key  text,
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  is_hold_point boolean NOT NULL DEFAULT false,
  planned_start date,
  planned_end   date,
  actual_start  date,
  actual_end    date,
  status        text NOT NULL DEFAULT 'Not Scheduled'
                  CHECK (status IN ('Not Scheduled','Scheduled','In Progress','On Hold','Blocked','Completed')),
  responsible   text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  sort_order    integer NOT NULL DEFAULT 0,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timeline_tasks_project_idx ON timeline_tasks (project_id);

CREATE TABLE task_dependencies (
  project_id          uuid NOT NULL REFERENCES projects(id),
  task_id             uuid NOT NULL REFERENCES timeline_tasks(id),
  depends_on_task_id  uuid NOT NULL REFERENCES timeline_tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

-- ---------------------------------------------------------------- visits
CREATE TABLE consultant_visits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id),
  planned_at          timestamptz,
  consultant_name     text NOT NULL DEFAULT '',
  consultant_user_id  uuid REFERENCES users(id),
  purpose             text NOT NULL,
  areas_inspected     text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'Planned'
                        CHECK (status IN ('Planned','In Progress','Completed','Rescheduled','Cancelled')),
  observations        text NOT NULL DEFAULT '',
  instructions        text NOT NULL DEFAULT '',
  next_visit_date     date,
  related_task_id     uuid REFERENCES timeline_tasks(id),
  related_material_id uuid REFERENCES material_items(id),
  notes               text NOT NULL DEFAULT '',
  archived_at         timestamptz,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consultant_visits_project_idx ON consultant_visits (project_id);

CREATE TABLE site_visits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id),
  visit_at              timestamptz,
  assigned_user_id      uuid REFERENCES users(id),
  assigned_name         text NOT NULL DEFAULT '',
  purpose               text NOT NULL,
  areas                 text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'Planned'
                          CHECK (status IN ('Planned','In Progress','Completed','Rescheduled')),
  findings              text NOT NULL DEFAULT '',
  related_task_id       uuid REFERENCES timeline_tasks(id),
  related_material_id   uuid REFERENCES material_items(id),
  related_consultant_visit_id uuid REFERENCES consultant_visits(id),
  notes                 text NOT NULL DEFAULT '',
  archived_at           timestamptz,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_visits_project_idx ON site_visits (project_id);

-- follow-up actions raised by consultant or site visits
CREATE TABLE visit_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  visit_type   text NOT NULL CHECK (visit_type IN ('consultant','site')),
  visit_id     uuid NOT NULL,
  description  text NOT NULL,
  responsible  text NOT NULL DEFAULT '',
  due_date     date,
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Closed')),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_actions_visit_idx ON visit_actions (visit_type, visit_id);

-- contractor work updates
CREATE TABLE work_updates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id),
  author_id           uuid REFERENCES users(id),
  update_date         date NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  related_task_id     uuid REFERENCES timeline_tasks(id),
  related_material_id uuid REFERENCES material_items(id),
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_updates_project_idx ON work_updates (project_id);

-- ---------------------------------------------------------------- uploads
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  entity_type   text NOT NULL CHECK (entity_type IN ('payment_milestone','payment_transaction','material','consultant_visit','site_visit','work_update')),
  entity_id     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('payment_slip','consultant_report','delivery_note','site_photo','supporting_document')),
  original_name text NOT NULL,
  stored_name   text NOT NULL UNIQUE,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  uploaded_by   uuid REFERENCES users(id),
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id);
CREATE INDEX attachments_project_idx ON attachments (project_id);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  project_id  uuid REFERENCES projects(id),
  user_id     uuid REFERENCES users(id),
  user_email  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  summary     text NOT NULL DEFAULT '',
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_project_idx ON audit_log (project_id, created_at DESC);
