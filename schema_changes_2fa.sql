-- DDL for the new two_factor_secrets table
CREATE TABLE two_factor_secrets (
    user_uuid TEXT NOT NULL PRIMARY KEY,
    secret_type TEXT NOT NULL DEFAULT 'TOTP', -- e.g., 'TOTP'
    encrypted_secret TEXT NOT NULL, -- Stores the TOTP secret, "encrypted"
    is_enabled INTEGER NOT NULL DEFAULT 0, -- 0 for false, 1 for true
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, -- ISO 8601 format
    label TEXT, -- User-friendly label for the authenticator app (e.g., YourApp:user@example.com)
    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE
);
