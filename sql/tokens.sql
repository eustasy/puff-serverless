-- This table stores various types of tokens, such as email verification and password reset tokens.
-- email_address: Specific to email verification tokens. Stores the email address for email-specific tokens (e.g., verification). NULL for other token types.
-- token_type: Indicates the type of token (e.g., 'email_verification', 'password_reset', 'backup_email_verification').
-- expires_at: ISO 8601 format. The timestamp when the token becomes invalid.
-- created_at: ISO 8601 format. The timestamp when the token was created.
-- is_used: Indicates if the token has already been used (0 for false, 1 for true).
CREATE TABLE IF NOT EXISTS tokens (
    token_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_uuid TEXT NOT NULL,
    email_address TEXT,
    token_type TEXT NOT NULL,
    token_value TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tokens_user_uuid ON tokens(user_uuid);
CREATE INDEX IF NOT EXISTS idx_tokens_token_value ON tokens(token_value);
CREATE INDEX IF NOT EXISTS idx_tokens_token_type ON tokens(token_type);
