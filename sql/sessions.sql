-- DDL for the new sessions table
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    user_uuid TEXT NOT NULL,
    expires_at TEXT NOT NULL, -- ISO 8601 format
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, -- ISO 8601 format
    user_agent TEXT, -- Optional: Store client User-Agent string
    ip_address TEXT, -- Optional: Store client IP address
    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid)
);
