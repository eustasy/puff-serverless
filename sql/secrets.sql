CREATE TABLE IF NOT EXISTS secrets (
    user_uuid STRING NOT NULL,
    secret_type STRING NOT NULL,
    secret_value STRING NOT NULL,
    secret_created_at STRING NOT NULL,
    secret_last_used STRING NOT NULL
);

CREATE INDEX IF NOT EXISTS secret_user_uuid ON secrets(user_uuid);
