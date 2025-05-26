-- DDL for modifying the emails table to add is_primary column
ALTER TABLE emails ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0;

-- Note: After this migration, existing emails might all be '0'.
-- A separate script or manual update would be needed to set the initial primary email for existing users.
-- For new users registered through the existing flow, their first email is also added with is_primary = 0 by default.
-- The user_register function in src/users.js would need an update to set the first email as primary.
-- Or, the first email added for a user is assumed primary if no other email has is_primary = 1.
-- Application logic will be responsible for ensuring only one email is marked as primary per user during promotion/changes.
