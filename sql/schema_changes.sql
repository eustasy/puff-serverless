-- DDL for the new email_verifications table
CREATE TABLE email_verifications (
    verification_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uuid TEXT NOT NULL,
    email_address TEXT NOT NULL,
    verification_token TEXT NOT NULL UNIQUE,
    token_expires_at TEXT NOT NULL, -- ISO 8601 format
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, -- ISO 8601 format
    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid)
);

-- DDL for modifying the emails table
ALTER TABLE emails ADD COLUMN is_verified INTEGER DEFAULT 0; -- 0 for false, 1 for true
ALTER TABLE emails ADD COLUMN verified_at TEXT; -- ISO 8601 format, NULL if not verified
