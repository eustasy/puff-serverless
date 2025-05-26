CREATE TABLE IF NOT EXISTS emails (
    user_uuid STRING NOT NULL,
    email_address STRING PRIMARY KEY,
    email_verified INT,
    is_primary INTEGER NOT NULL DEFAULT 0
);
