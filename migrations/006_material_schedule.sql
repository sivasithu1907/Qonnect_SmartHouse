-- 006_material_schedule.sql — simplified material dates (owner delivery / contractor work)
--
-- Additive and safe for existing data:
--   * adds two nullable date columns for contractor work (planned / actual completion);
--   * adds two nullable timestamps that record when an authorised user confirmed which saved date
--     is the planned date (owner delivery schedule / contractor work schedule).
-- No existing column, value, status or record is changed, moved or removed. The older date fields
-- (required on site, supplier-confirmed, revised, delivery date note) stay in place and are shown
-- under "Previous date details". Old delivery dates are never copied into completion dates.
-- Rollback compatibility: the previous app version ignores the new columns.

ALTER TABLE material_items
  ADD COLUMN planned_completion_date date,
  ADD COLUMN actual_completion_date date,
  ADD COLUMN delivery_schedule_confirmed_at timestamptz,
  ADD COLUMN work_schedule_confirmed_at timestamptz;
