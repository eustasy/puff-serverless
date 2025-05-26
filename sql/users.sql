CREATE TABLE IF NOT EXISTS users (
    user_uuid STRING PRIMARY KEY,
    user_name STRING NOT NULL,
    user_active INT NOT NULL DEFAULT 1
);
