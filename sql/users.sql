CREATE TABLE IF NOT EXISTS secrets (
    user_uuid STRING PRIMARY KEY,
    user_name STRING NOT NULL,
    user_active STRING NOT NULL
);
