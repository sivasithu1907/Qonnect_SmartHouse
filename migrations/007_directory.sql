-- 007_directory.sql — shared Contacts / Companies directory with project assignments
--
-- Additive and safe for existing data:
--   * new tables: directory_specializations (configurable values), directory_entries (companies /
--     independent individuals), directory_contacts (people under an entry), directory_assignments
--     (who does what on which project);
--   * nullable directory_entry_id / directory_contact_id columns on contracts, payment_milestones,
--     material_items, consultant_visits, site_visits and timeline_tasks. Existing text names
--     (company_name, payee_name, vendor, consultant_name, assigned_name, responsible) are untouched
--     and remain the recorded historical names; nothing is linked or created automatically;
--   * attachments: project_id may be NULL only for shared directory documents (entity_type
--     'directory_entry'); every existing row keeps its project. Two document kinds are added.
-- No existing value, record or file is changed, moved or removed. No user account or project access
-- is created by adding a contact or an assignment.
-- Rollback compatibility: the previous app version ignores the new tables and columns; its
-- attachment queries always filter by project, so shared directory documents are never listed.

-- ------------------------------------------------------------------ configurable specializations
CREATE TABLE directory_specializations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  sort_order  integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX directory_specializations_name_uq ON directory_specializations (lower(btrim(name)));
INSERT INTO directory_specializations (name, sort_order) VALUES
  ('Civil', 1), ('Gypsum', 2), ('Tiles / Marble', 3), ('Plumbing', 4), ('Electrical', 5), ('AC / HVAC', 6),
  ('KNX / Home Automation', 7), ('CCTV / ELV', 8), ('Painting', 9), ('Landscaping', 10);

-- ------------------------------------------------------------------ directory entries
CREATE SEQUENCE directory_ref_seq START 1;

CREATE TABLE directory_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref               text NOT NULL UNIQUE DEFAULT ('DIR-' || lpad(nextval('directory_ref_seq')::text, 4, '0')),
  display_name      text NOT NULL CHECK (btrim(display_name) <> ''),
  entity_type       text NOT NULL CHECK (entity_type IN ('company','individual')),
  roles             text[] NOT NULL CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['consultant','supplier','main_contractor','finishing_contractor','subcontractor','other']::text[]),
  specializations   text[] NOT NULL DEFAULT '{}',
  phone             text NOT NULL DEFAULT '',
  phone_normalized  text NOT NULL DEFAULT '',
  email             text NOT NULL DEFAULT '',
  address           text NOT NULL DEFAULT '',
  website           text NOT NULL DEFAULT '',
  registration_no   text NOT NULL DEFAULT '',
  drive_url         text NOT NULL DEFAULT '',
  quotations_url    text NOT NULL DEFAULT '',
  notes             text NOT NULL DEFAULT '',
  archived_at       timestamptz,
  created_by        uuid REFERENCES users(id),
  updated_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_entries_name_idx ON directory_entries (lower(display_name));
CREATE INDEX directory_entries_phone_idx ON directory_entries (phone_normalized) WHERE phone_normalized <> '';
CREATE INDEX directory_entries_email_idx ON directory_entries (lower(email)) WHERE email <> '';

-- ------------------------------------------------------------------ contact people
CREATE TABLE directory_contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id           uuid NOT NULL REFERENCES directory_entries(id),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  position           text NOT NULL DEFAULT '',
  mobile             text NOT NULL DEFAULT '',
  mobile_normalized  text NOT NULL DEFAULT '',
  email              text NOT NULL DEFAULT '',
  is_primary         boolean NOT NULL DEFAULT false,
  notes              text NOT NULL DEFAULT '',
  archived_at        timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_contacts_entry_idx ON directory_contacts (entry_id);
CREATE INDEX directory_contacts_mobile_idx ON directory_contacts (mobile_normalized) WHERE mobile_normalized <> '';
-- at most one active primary contact per entry
CREATE UNIQUE INDEX directory_contacts_primary_uq ON directory_contacts (entry_id) WHERE is_primary AND archived_at IS NULL;

-- ------------------------------------------------------------------ project assignments
CREATE TABLE directory_assignments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id                uuid NOT NULL REFERENCES directory_entries(id),
  project_id              uuid NOT NULL REFERENCES projects(id),
  roles                   text[] NOT NULL CHECK (cardinality(roles) >= 1 AND roles <@ ARRAY['consultant','supplier','main_contractor','finishing_contractor','subcontractor','other']::text[]),
  scope                   text NOT NULL DEFAULT '',
  responsible_contact_id  uuid REFERENCES directory_contacts(id),
  start_date              date,
  end_date                date,
  notes                   text NOT NULL DEFAULT '',
  archived_at             timestamptz,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX directory_assignments_project_idx ON directory_assignments (project_id);
CREATE INDEX directory_assignments_entry_idx ON directory_assignments (entry_id);
-- one active assignment per entry and project (archived ones stay as history)
CREATE UNIQUE INDEX directory_assignments_active_uq ON directory_assignments (entry_id, project_id) WHERE archived_at IS NULL;

-- ------------------------------------------------------------------ optional links from existing records
ALTER TABLE contracts          ADD COLUMN directory_entry_id uuid REFERENCES directory_entries(id), ADD COLUMN directory_contact_id uuid REFERENCES directory_contacts(id);
ALTER TABLE payment_milestones ADD COLUMN directory_entry_id uuid REFERENCES directory_entries(id), ADD COLUMN directory_contact_id uuid REFERENCES directory_contacts(id);
ALTER TABLE material_items     ADD COLUMN directory_entry_id uuid REFERENCES directory_entries(id), ADD COLUMN directory_contact_id uuid REFERENCES directory_contacts(id);
ALTER TABLE consultant_visits  ADD COLUMN directory_entry_id uuid REFERENCES directory_entries(id), ADD COLUMN directory_contact_id uuid REFERENCES directory_contacts(id);
ALTER TABLE site_visits        ADD COLUMN directory_entry_id uuid REFERENCES directory_entries(id), ADD COLUMN directory_contact_id uuid REFERENCES directory_contacts(id);
ALTER TABLE timeline_tasks     ADD COLUMN directory_entry_id uuid REFERENCES directory_entries(id), ADD COLUMN directory_contact_id uuid REFERENCES directory_contacts(id);
CREATE INDEX contracts_directory_idx          ON contracts (directory_entry_id) WHERE directory_entry_id IS NOT NULL;
CREATE INDEX payment_milestones_directory_idx ON payment_milestones (directory_entry_id) WHERE directory_entry_id IS NOT NULL;
CREATE INDEX material_items_directory_idx     ON material_items (directory_entry_id) WHERE directory_entry_id IS NOT NULL;
CREATE INDEX consultant_visits_directory_idx  ON consultant_visits (directory_entry_id) WHERE directory_entry_id IS NOT NULL;
CREATE INDEX site_visits_directory_idx        ON site_visits (directory_entry_id) WHERE directory_entry_id IS NOT NULL;
CREATE INDEX timeline_tasks_directory_idx     ON timeline_tasks (directory_entry_id) WHERE directory_entry_id IS NOT NULL;

-- ------------------------------------------------------------------ attachments: directory documents
-- Shared company documents have no project (project_id NULL); project-specific directory documents
-- keep their project_id and are only visible to that project's users.
ALTER TABLE attachments ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN (
  'payment_milestone','payment_transaction','material','consultant_visit','site_visit','work_update',
  'contract','contract_amendment','prerequisite','directory_entry'));
ALTER TABLE attachments ADD CONSTRAINT attachments_project_scope_check CHECK (project_id IS NOT NULL OR entity_type = 'directory_entry');
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN (
  'payment_slip','consultant_report','delivery_note','site_photo','supporting_document',
  'signed_contract','quotation','boq','amendment','company_profile','trade_license'));
