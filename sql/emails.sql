CREATE TABLE IF NOT EXISTS emails (
    user_uuid STRING NOT NULL,
    email_address STRING PRIMARY KEY,
    is_verified INTEGER DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT DEFAULT NULL
);
