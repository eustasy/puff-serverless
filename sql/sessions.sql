-- DDL for the new sessions table
-- expires_at: ISO 8601 format
-- created_at: ISO 8601 format
-- user_agent: Optional: Store client User-Agent string
-- ip_address: Optional: Store client IP address
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    user_uuid TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_agent TEXT,
    ip_address TEXT,
    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid)
);
