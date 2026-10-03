-- 004_contracts.sql — project-specific Contracts & Documents
--
-- Additive and safe for existing data. This migration:
--   * adds per-project CONTRACT categories and gives every existing project the four default
--     categories (Main Contractor, Finishing Works, Consultant, Other) — no contracts are created;
--   * adds contract records and separately recorded amendments, both scoped to one project;
--   * adds an optional, nullable contract link on payment milestones (existing milestones keep NULL);
--   * widens the attachments CHECK constraints so the existing secure upload system can store
--     contract documents (new entity types / document types only — existing values unchanged).
--
-- It does NOT change any budget amount, payment milestone amount, transfer or status.
-- Rollback compatibility: the previous app version ignores the new tables and the nullable column.

-- ------------------------------------------------------------------ contract categories
CREATE TABLE contract_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX contract_categories_name_uq ON contract_categories (project_id, lower(btrim(name)));
CREATE INDEX contract_categories_project_idx ON contract_categories (project_id, sort_order);

INSERT INTO contract_categories (project_id, name, sort_order)
SELECT p.id, d.name, d.ord
  FROM projects p
 CROSS JOIN (VALUES ('Main Contractor', 1), ('Finishing Works', 2), ('Consultant', 3), ('Other', 4)) AS d(name, ord);

-- ------------------------------------------------------------------ contracts
CREATE TABLE contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  title           text NOT NULL CHECK (btrim(title) <> ''),
  category_id     uuid NOT NULL REFERENCES contract_categories(id),
  company_name    text NOT NULL CHECK (btrim(company_name) <> ''),
  reference       text NOT NULL DEFAULT '',
  signed_date     date,
  contract_value  numeric(14,2) CHECK (contract_value IS NULL OR contract_value >= 0),
  status          text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Signed','Active','Completed','Terminated')),
  notes           text NOT NULL DEFAULT '',
  drive_url       text NOT NULL DEFAULT '',
  budget_item_id  uuid REFERENCES budget_items(id),
  archived_at     timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contracts_project_idx ON contracts (project_id, archived_at);
CREATE INDEX contracts_category_idx ON contracts (category_id);
CREATE INDEX contracts_budget_item_idx ON contracts (budget_item_id) WHERE budget_item_id IS NOT NULL;

-- ------------------------------------------------------------------ amendments (the signed original is never replaced)
CREATE TABLE contract_amendments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  contract_id     uuid NOT NULL REFERENCES contracts(id),
  amendment_date  date NOT NULL,
  description     text NOT NULL CHECK (btrim(description) <> ''),
  reference       text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  archived_at     timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_amendments_contract_idx ON contract_amendments (contract_id, amendment_date);
CREATE INDEX contract_amendments_project_idx ON contract_amendments (project_id);

-- ------------------------------------------------------------------ optional link from payment milestones
ALTER TABLE payment_milestones ADD COLUMN contract_id uuid REFERENCES contracts(id);
CREATE INDEX payment_milestones_contract_idx ON payment_milestones (contract_id) WHERE contract_id IS NOT NULL;

-- ------------------------------------------------------------------ attachments: allow contract documents
-- Drop the existing (auto-named) CHECK constraints on attachments.entity_type / attachments.kind,
-- whatever their names are, then add named ones that include the new values.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE rel.relname = 'attachments' AND ns.nspname = current_schema() AND con.contype = 'c'
       AND (pg_get_constraintdef(con.oid) LIKE '%entity_type%' OR pg_get_constraintdef(con.oid) LIKE '%kind%')
  LOOP
    EXECUTE format('ALTER TABLE attachments DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN (
  'payment_milestone','payment_transaction','material','consultant_visit','site_visit','work_update',
  'contract','contract_amendment'));
ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN (
  'payment_slip','consultant_report','delivery_note','site_photo','supporting_document',
  'signed_contract','quotation','boq','amendment'));
