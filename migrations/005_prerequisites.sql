-- 005_prerequisites.sql — project-specific prerequisites & documents checklist
--
-- Additive and safe for existing data:
--   * adds an empty project_prerequisites table (no items are created for any project);
--   * widens the attachments entity_type CHECK so the existing secure upload system can hold
--     files for a prerequisite (existing files and values are unchanged).
-- Status changes to Completed / Not applicable record who decided and when. Uploading a file
-- never changes a prerequisite's status.
-- Rollback compatibility: the previous app version ignores the new table.

CREATE TABLE project_prerequisites (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id),
  title                text NOT NULL CHECK (btrim(title) <> ''),
  status               text NOT NULL DEFAULT 'Not started'
                         CHECK (status IN ('Not started','In progress','Awaiting review','Completed','Not applicable')),
  phase_id             uuid REFERENCES timeline_phases(id),
  responsible_user_id  uuid REFERENCES users(id),
  responsible_name     text NOT NULL DEFAULT '',
  due_date             date,
  completed_on         date,
  decided_by           uuid REFERENCES users(id),
  decided_at           timestamptz,
  contract_id          uuid REFERENCES contracts(id),
  document_url         text NOT NULL DEFAULT '',
  notes                text NOT NULL DEFAULT '',
  sort_order           integer NOT NULL DEFAULT 0,
  archived_at          timestamptz,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- a completed item always has a recorded completion date; other statuses never do
  CHECK ((status = 'Completed') = (completed_on IS NOT NULL)),
  -- Completed / Not applicable are explicit decisions with a recorded decision time
  CHECK ((status IN ('Completed','Not applicable')) = (decided_at IS NOT NULL))
);
CREATE INDEX project_prerequisites_project_idx ON project_prerequisites (project_id, archived_at, sort_order);

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN (
  'payment_milestone','payment_transaction','material','consultant_visit','site_visit','work_update',
  'contract','contract_amendment','prerequisite'));
