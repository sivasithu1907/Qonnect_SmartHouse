-- 009_payment_categories_site_visits.sql — payment cost category linked to the master budget categories,
-- and the site visit workflow (start / complete / reschedule / cancel, findings and decisions).
--
-- Additive and safe for existing data:
--   * payment_milestones.cost_category (free text) is kept exactly as stored. A new nullable reference
--     payment_milestones.budget_category_id points at this project's budget_categories (Master Items & Budget).
--   * Only unambiguous records are linked automatically:
--       1. a payment already linked to a budget item gets that item's category (the item's category is authoritative);
--       2. a payment without a budget item whose text matches exactly one category name of the same project
--          (ignoring case and repeated spaces, archived categories included) gets that category.
--     Everything else stays unlinked; its original text is shown as a legacy value needing review.
--     Every automatic link is written to the audit log. Running the mapping again changes nothing.
--   * No amount, transfer, slip, budget item link, contract link or status is changed.
--   * site_visits keeps every stored status. 'Cancelled' is added to the allowed values; new nullable or
--     defaulted columns hold the actual visit time, the start time, a cancellation reason and decisions.
--     No actual date is inferred for historical visits.
-- Rollback compatibility: the previous app version ignores the new columns. A visit cancelled with this
-- version would show the status text "Cancelled" in the previous version's list.

-- ------------------------------------------------------------------ payments: category reference
ALTER TABLE payment_milestones ADD COLUMN IF NOT EXISTS budget_category_id uuid REFERENCES budget_categories(id);
CREATE INDEX IF NOT EXISTS payment_milestones_category_idx ON payment_milestones (budget_category_id) WHERE budget_category_id IS NOT NULL;

-- 1. linked budget item → its category
WITH mapped AS (
  UPDATE payment_milestones m
     SET budget_category_id = bi.category_id
    FROM budget_items bi
   WHERE m.budget_category_id IS NULL AND m.budget_item_id = bi.id AND bi.project_id = m.project_id
  RETURNING m.id, m.project_id, m.cost_category, m.description, bi.category_id
)
INSERT INTO audit_log (project_id, user_id, user_email, action, entity_type, entity_id, summary, after)
SELECT mp.project_id, NULL, 'system (migration 009)', 'update', 'payment_milestone', mp.id::text,
       format('Cost category linked from the related budget item: %s%s', bc.name,
              CASE WHEN btrim(mp.cost_category) <> '' AND lower(regexp_replace(btrim(mp.cost_category), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(bc.name), '\s+', ' ', 'g'))
                   THEN format(' (recorded text "%s" kept for review)', mp.cost_category) ELSE '' END),
       jsonb_build_object('budget_category_id', mp.category_id)
  FROM mapped mp JOIN budget_categories bc ON bc.id = mp.category_id;

-- 2. no budget item, text matches exactly one category name of the same project
WITH candidates AS (
  SELECT m.id AS milestone_id, min(bc.id::text)::uuid AS category_id, count(*) AS n
    FROM payment_milestones m
    JOIN budget_categories bc ON bc.project_id = m.project_id
     AND lower(regexp_replace(btrim(bc.name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(m.cost_category), '\s+', ' ', 'g'))
   WHERE m.budget_category_id IS NULL AND m.budget_item_id IS NULL AND btrim(m.cost_category) <> ''
   GROUP BY m.id
), mapped AS (
  UPDATE payment_milestones m
     SET budget_category_id = c.category_id
    FROM candidates c
   WHERE c.milestone_id = m.id AND c.n = 1
  RETURNING m.id, m.project_id, m.cost_category, c.category_id
)
INSERT INTO audit_log (project_id, user_id, user_email, action, entity_type, entity_id, summary, after)
SELECT mp.project_id, NULL, 'system (migration 009)', 'update', 'payment_milestone', mp.id::text,
       format('Cost category "%s" linked to the budget category %s (exact name match)', mp.cost_category, bc.name),
       jsonb_build_object('budget_category_id', mp.category_id)
  FROM mapped mp JOIN budget_categories bc ON bc.id = mp.category_id;

-- ------------------------------------------------------------------ site visits: workflow
ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_status_check;
ALTER TABLE site_visits ADD CONSTRAINT site_visits_status_check
  CHECK (status IN ('Planned','In Progress','Completed','Rescheduled','Cancelled'));
ALTER TABLE site_visits ADD COLUMN IF NOT EXISTS actual_visit_at timestamptz;
ALTER TABLE site_visits ADD COLUMN IF NOT EXISTS started_at      timestamptz;
ALTER TABLE site_visits ADD COLUMN IF NOT EXISTS cancel_reason   text NOT NULL DEFAULT '';
ALTER TABLE site_visits ADD COLUMN IF NOT EXISTS decisions       text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS visit_actions_open_idx ON visit_actions (project_id, visit_type, due_date) WHERE status = 'Open' AND archived_at IS NULL;
