-- 011_user_avatars.sql — optional profile pictures for users.
--
-- Additive and safe for existing data: four nullable columns on users, empty for every existing user.
--   avatar_file        generated file name (<uuid>.webp) under <UPLOAD_DIR>/_avatars/ — never a user-supplied name
--   avatar_sha256      checksum of the stored file (used by Backup & Restore)
--   avatar_size_bytes  size of the stored file
--   avatar_updated_at  when the picture was last saved (also used to refresh cached images)
-- No other user field, role, password, session or project membership is changed.
-- Rollback compatibility: the previous app version ignores these columns and shows initials as before.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file       text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_sha256     text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_size_bytes integer;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_file_check;
ALTER TABLE users ADD CONSTRAINT users_avatar_file_check
  CHECK (avatar_file IS NULL OR avatar_file ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$');
