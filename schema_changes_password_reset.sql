-- DDL for the new password_reset_tokens table
CREATE TABLE password_reset_tokens (
    token_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uuid TEXT NOT NULL,
    reset_token TEXT NOT NULL UNIQUE,
    token_expires_at TEXT NOT NULL, -- ISO 8601 format
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, -- ISO 8601 format
    is_used INTEGER NOT NULL DEFAULT 0, -- 0 for false, 1 for true
    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE
);
