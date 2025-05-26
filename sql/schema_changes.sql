-- DDL for modifying the emails table
-- is_verified: 0 for false, 1 for true
ALTER TABLE emails ADD COLUMN is_verified INTEGER DEFAULT 0;
-- verified_at: ISO 8601 format, NULL if not verified
ALTER TABLE emails ADD COLUMN verified_at TEXT;
