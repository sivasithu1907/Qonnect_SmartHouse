-- 008_documents_visits.sql — project documents, budget item attachments, consultant visit workflow,
-- contact-person WhatsApp numbers and assignment status, file display names.
--
-- Additive and safe for existing data:
--   * new tables start empty: nothing is created or copied automatically;
--   * new columns are nullable or have defaults; no existing value is rewritten;
--   * existing attachments keep their entity, file, name and checksum. Prerequisite files stay attached
--     to their prerequisite and are listed in the central document register with their source;
--   * consultant visit statuses are kept exactly as stored (Planned / In Progress / Rescheduled map to
--     "Scheduled" in the interface).
-- Rollback compatibility: the previous app version ignores the new tables and columns. Files uploaded to
-- the new record types (project documents, budget items) are simply not listed by the previous version.

-- ------------------------------------------------------------------ project documents (central register)
CREATE TABLE project_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id),
  title          text NOT NULL CHECK (btrim(title) <> ''),
  category       text NOT NULL DEFAULT 'other'
                   CHECK (category IN ('permit','drawing','survey','approval','report','certificate','correspondence','other')),
  reference      text NOT NULL DEFAULT '',
  document_date  date,
  drive_url      text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',
  archived_at    timestamptz,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_documents_project_idx ON project_documents (project_id, archived_at);

-- a prerequisite (requirement) references documents (evidence) from the register; no file is copied
CREATE TABLE prerequisite_documents (
  prerequisite_id uuid NOT NULL REFERENCES project_prerequisites(id),
  document_id     uuid NOT NULL REFERENCES project_documents(id),
  project_id      uuid NOT NULL REFERENCES projects(id),
  linked_by       uuid REFERENCES users(id),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (prerequisite_id, document_id)
);
CREATE INDEX prerequisite_documents_document_idx ON prerequisite_documents (document_id);

-- ------------------------------------------------------------------ attachments
-- display_name: a corrected / friendlier name shown and used for downloads; original_name is never changed.
ALTER TABLE attachments ADD COLUMN display_name text CHECK (display_name IS NULL OR btrim(display_name) <> '');
ALTER TABLE attachments ADD COLUMN description  text NOT NULL DEFAULT '';
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN (
  'payment_milestone','payment_transaction','material','consultant_visit','site_visit','work_update',
  'contract','contract_amendment','prerequisite','directory_entry','project_document','budget_item'));
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN (
  'payment_slip','consultant_report','delivery_note','site_photo','supporting_document',
  'signed_contract','quotation','boq','amendment','company_profile','trade_license',
  'specification','invoice','drawing','permit','approval','other'));

-- ------------------------------------------------------------------ budget items: optional Drive folder link
ALTER TABLE budget_items ADD COLUMN drive_url text NOT NULL DEFAULT '';

-- ------------------------------------------------------------------ consultant visits
ALTER TABLE consultant_visits ADD COLUMN actual_visit_at      timestamptz;
ALTER TABLE consultant_visits ADD COLUMN assigned_user_id     uuid REFERENCES users(id);
ALTER TABLE consultant_visits ADD COLUMN related_milestone_id uuid REFERENCES payment_milestones(id);
ALTER TABLE consultant_visits ADD COLUMN cancel_reason        text NOT NULL DEFAULT '';

-- comments / activity notes on visits (consultant or site), with author and time
CREATE TABLE visit_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  visit_type  text NOT NULL CHECK (visit_type IN ('consultant','site')),
  visit_id    uuid NOT NULL,
  author_id   uuid REFERENCES users(id),
  body        text NOT NULL CHECK (btrim(body) <> ''),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_comments_visit_idx ON visit_comments (visit_type, visit_id, created_at);

-- follow-up actions: optional internal responsible user (the text name stays)
ALTER TABLE visit_actions ADD COLUMN responsible_user_id uuid REFERENCES users(id);

-- ------------------------------------------------------------------ contacts directory
ALTER TABLE directory_contacts ADD COLUMN whatsapp text NOT NULL DEFAULT '';
ALTER TABLE directory_contacts ADD COLUMN whatsapp_normalized text NOT NULL DEFAULT '';
ALTER TABLE directory_assignments ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','on_hold','completed'));
