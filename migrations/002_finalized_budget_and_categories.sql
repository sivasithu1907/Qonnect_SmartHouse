-- 002_finalized_budget_and_categories.sql
--
-- Safe for existing data. This migration:
--   * adds per-project MATERIAL categories (managed centrally, used as dropdowns) and links
--     existing material lines and scope notes to them, keeping every existing record, name and order;
--   * restricts the misc-allowance basis to approved/finalized amounts;
--   * removes seeded Variant A / Variant B wording from notes (exact seeded strings only).
--
-- It does NOT delete, overwrite or copy any amount. The legacy source/variant columns
-- (budget_items.source_amount / source_variant_a / source_variant_b / source_status and the
-- source_references table) are left in place, unchanged, but are no longer read by the app.
-- No variant value is ever copied into approved_amount.
--
-- Rollback compatibility: the previous app version keeps working against this schema.
-- New columns are nullable and a trigger links material lines/scope notes that an older
-- version inserts by category name only.

-- ------------------------------------------------------------------ material categories
CREATE TABLE material_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX material_categories_name_uq ON material_categories (project_id, lower(btrim(name)));
CREATE INDEX material_categories_project_idx ON material_categories (project_id, sort_order);

-- one category per distinct existing material category (case/space-insensitive),
-- ordered as the lines currently appear
INSERT INTO material_categories (project_id, name, sort_order)
SELECT project_id, name, row_number() OVER (PARTITION BY project_id ORDER BY first_sort, first_created)
FROM (
  SELECT project_id,
         (array_agg(btrim(category) ORDER BY sort_order, created_at))[1] AS name,  -- first-used spelling
         min(sort_order)               AS first_sort,
         min(created_at)               AS first_created
    FROM material_items
   WHERE btrim(category) <> ''
   GROUP BY project_id, lower(btrim(category))
) g;

-- categories that only exist in scope notes
INSERT INTO material_categories (project_id, name, sort_order)
SELECT n.project_id, (array_agg(btrim(n.category) ORDER BY n.created_at))[1],
       (SELECT COALESCE(max(sort_order), 0) FROM material_categories c WHERE c.project_id = n.project_id)
         + row_number() OVER (PARTITION BY n.project_id ORDER BY lower(btrim(n.category)))
  FROM material_scope_notes n
 WHERE btrim(n.category) <> ''
   AND NOT EXISTS (SELECT 1 FROM material_categories c
                    WHERE c.project_id = n.project_id AND lower(btrim(c.name)) = lower(btrim(n.category)))
 GROUP BY n.project_id, lower(btrim(n.category));

ALTER TABLE material_items ADD COLUMN category_id uuid REFERENCES material_categories(id);
UPDATE material_items m SET category_id = c.id
  FROM material_categories c
 WHERE c.project_id = m.project_id AND lower(btrim(c.name)) = lower(btrim(m.category));
CREATE INDEX material_items_category_idx ON material_items (category_id);
-- lines whose name differed only by case/spaces now show the category's name
UPDATE material_items m SET category = c.name
  FROM material_categories c WHERE c.id = m.category_id AND m.category <> c.name;

ALTER TABLE material_scope_notes ADD COLUMN category_id uuid REFERENCES material_categories(id);
UPDATE material_scope_notes n SET category_id = c.id
  FROM material_categories c
 WHERE c.project_id = n.project_id AND lower(btrim(c.name)) = lower(btrim(n.category));
UPDATE material_scope_notes n SET category = c.name
  FROM material_categories c WHERE c.id = n.category_id AND n.category <> c.name;
CREATE INDEX material_scope_notes_category_idx ON material_scope_notes (category_id);

-- Keep category_id and the category name text consistent for any writer (including an older
-- app version after a code rollback): a missing category_id is resolved/created from the name,
-- and the name text always mirrors the linked category.
CREATE OR REPLACE FUNCTION link_material_category() RETURNS trigger AS $$
DECLARE cid uuid; cname text;
BEGIN
  -- an UPDATE that changes only the name text re-resolves the category by name
  IF TG_OP = 'UPDATE' AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id
     AND NEW.category IS DISTINCT FROM OLD.category THEN
    NEW.category_id := NULL;
  END IF;
  IF NEW.category_id IS NULL AND btrim(COALESCE(NEW.category, '')) <> '' THEN
    SELECT id INTO cid FROM material_categories
     WHERE project_id = NEW.project_id AND lower(btrim(name)) = lower(btrim(NEW.category));
    IF cid IS NULL THEN
      INSERT INTO material_categories (project_id, name, sort_order)
      VALUES (NEW.project_id, btrim(NEW.category),
              (SELECT COALESCE(max(sort_order), 0) + 1 FROM material_categories WHERE project_id = NEW.project_id))
      RETURNING id INTO cid;
    END IF;
    NEW.category_id := cid;
  END IF;
  IF NEW.category_id IS NOT NULL THEN
    SELECT name INTO cname FROM material_categories WHERE id = NEW.category_id AND project_id = NEW.project_id;
    IF cname IS NULL THEN
      RAISE EXCEPTION 'material category does not belong to this project';
    END IF;
    NEW.category := cname;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER material_items_link_category
  BEFORE INSERT OR UPDATE OF category, category_id ON material_items
  FOR EACH ROW EXECUTE FUNCTION link_material_category();
CREATE TRIGGER material_scope_notes_link_category
  BEFORE INSERT OR UPDATE OF category, category_id ON material_scope_notes
  FOR EACH ROW EXECUTE FUNCTION link_material_category();

-- ------------------------------------------------------------------ finalized-only budget
-- The misc allowance may only be calculated on approved/finalized amounts.
UPDATE projects SET misc_basis = 'approved_finishing' WHERE misc_basis <> 'approved_finishing';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_misc_basis_check;
ALTER TABLE projects ADD CONSTRAINT projects_misc_basis_check CHECK (misc_basis = 'approved_finishing');

-- Remove seeded Variant A / B wording (exact seeded text only; user-written notes are untouched)
UPDATE budget_items
   SET notes = ''
 WHERE notes IN (
   'Variant A – Individual / Variant B – Al Wathab are reference estimates only, not approved commitments.',
   'Source amount. Approved amount needs confirmation.'
 );
UPDATE budget_categories
   SET notes = 'Editing an amount never creates a payment.'
 WHERE notes = 'Fixed cost subtotal shown in source: QAR 572,500.00. Editing an amount never creates a payment or marks it paid.'
    OR notes = 'Fixed cost subtotal shown in source: QAR 572,500.00. Editing an amount never creates a payment.';
UPDATE budget_categories SET notes = '' WHERE notes = 'Template structure — no values';
-- seeded item names like "Floor (category estimate)" become the plain category name
UPDATE budget_items i SET name = c.name
  FROM budget_categories c
 WHERE i.category_id = c.id AND i.name = c.name || ' (category estimate)';
