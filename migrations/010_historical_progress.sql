-- 010_historical_progress.sql — recording work completed before a project was entered into the application.
--
-- Additive and safe for existing data:
--   * projects.allow_historical_progress (default false). When true, authorised users may record task completion
--     with "exact completion date unknown" and complete several tasks of a phase in one reviewed action.
--     It is switched on here only for the existing project PIN 70153699 (Umm Garn), and only when exactly one
--     project has that code. Every other and every new project stays off. An admin can change it in project settings.
--   * timeline_tasks gains completion details, all empty / false for existing rows:
--       completion_date_unknown  — the task is completed but its actual completion date is not known (actual_end stays empty)
--       completion_note          — why / how the completion was recorded (e.g. completed before the app was used)
--       completion_recorded_at / completion_recorded_by — when and by whom the completion was entered (not when the work happened)
--       completion_historical    — recorded through the historical-progress workflow
--   * No task status, date, note, dependency or file is changed. Nothing is marked completed.
-- Rollback compatibility: the previous app version ignores the new columns. A task completed with an unknown date shows
-- as Completed without a completion date there.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS allow_historical_progress boolean NOT NULL DEFAULT false;

ALTER TABLE timeline_tasks ADD COLUMN IF NOT EXISTS completion_date_unknown boolean NOT NULL DEFAULT false;
ALTER TABLE timeline_tasks ADD COLUMN IF NOT EXISTS completion_note        text NOT NULL DEFAULT '';
ALTER TABLE timeline_tasks ADD COLUMN IF NOT EXISTS completion_recorded_at timestamptz;
ALTER TABLE timeline_tasks ADD COLUMN IF NOT EXISTS completion_recorded_by uuid REFERENCES users(id);
ALTER TABLE timeline_tasks ADD COLUMN IF NOT EXISTS completion_historical  boolean NOT NULL DEFAULT false;
ALTER TABLE timeline_tasks DROP CONSTRAINT IF EXISTS timeline_tasks_completion_unknown_check;
ALTER TABLE timeline_tasks ADD CONSTRAINT timeline_tasks_completion_unknown_check
  CHECK (NOT completion_date_unknown OR (status = 'Completed' AND actual_end IS NULL));

-- enable historical progress entry for the existing project PIN 70153699 only (exactly one match required)
WITH target AS (
  SELECT id FROM projects WHERE upper(regexp_replace(btrim(code), '\s+', ' ', 'g')) = 'PIN 70153699'
), enabled AS (
  UPDATE projects p SET allow_historical_progress = true
   WHERE p.id IN (SELECT id FROM target) AND (SELECT count(*) FROM target) = 1 AND NOT p.allow_historical_progress
  RETURNING p.id
)
INSERT INTO audit_log (project_id, user_id, user_email, action, entity_type, entity_id, summary, after)
SELECT id, NULL, 'system (migration 010)', 'update', 'project_settings', id::text,
       'Allowed historical progress entry for this existing project (work completed before it was entered into the application)',
       jsonb_build_object('allow_historical_progress', true)
  FROM enabled;
